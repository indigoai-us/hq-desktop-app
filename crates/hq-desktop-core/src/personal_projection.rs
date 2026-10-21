//! Typed client for the hq-cloud `personal-projection` wrapper (H8).
//!
//! The wrapper is the only writer allowed to create, adopt, or resume a
//! personal projection root. It is reached through the same hq-cloud package
//! the sync runner uses, with argv `personal-projection ACTION --stdin-json`,
//! one JSON request on stdin, and one bounded JSON result on stdout.
//!
//! This module only maps the contract to Rust types. It has no callers yet:
//! the setup coordinator and the adoption review screen are separate, gated
//! changes. Its rules:
//!
//! * The first call in a client session is a schema-1 `inspect` of the
//!   intended root. That is the feature probe. Any other action runs only after
//!   the probe returned a typed result.
//! * Usage text, exit 2 without typed JSON, non-JSON output, an unknown status
//!   or reason, a missing field, an unknown field, or a reason whose
//!   `retryable`/`requiredAction` disagree with the contract all classify as
//!   [`LocalPause::UnsupportedCli`]. There is no legacy fallback.
//! * Plans are kept as the exact bytes the wrapper returned and are sent back
//!   verbatim. Approvals are never synthesized here: each phase needs a
//!   [`UserApproval`] whose phase and digest match the plan.
//! * Requests over the contract limits are refused before anything is spawned.

use std::io::{Read, Write};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// Contract schema version for every request and result.
pub const SCHEMA_VERSION: u32 = 1;

/// Request limit for `inspect`, `initialize`, and `plan-adoption`.
pub const ROOT_REQUEST_LIMIT: usize = 65_536;

/// Request limit for `preserve`, `adopt`, `baseline`, and `resume`.
pub const PHASE_REQUEST_LIMIT: usize = 16 * 1024 * 1024;

/// Largest stdout the client reads. A plan must fit back into a phase request,
/// so a result larger than the phase limit plus envelope slack is not usable.
pub const MAX_RESULT_BYTES: usize = PHASE_REQUEST_LIMIT + ROOT_REQUEST_LIMIT;

/// The plan's fixed upload deadline from the contract.
pub const PLAN_MAX_DURATION_MS: u64 = 600_000;

/// The hq-cloud package bin that dispatches `personal-projection`.
pub const PROJECTION_BIN: &str = "hq-cloud";

const ADOPT_DISPOSITION: &str = "reviewed-preserved-bytes-belong-to-authenticated-destination";
const BASELINE_DISPOSITION: &str = "upload-only-reviewed-snapshot-to-pinned-destination";
const RESUME_DISPOSITION: &str = "resume-verified-personal-projection";

/// The seven wrapper actions, exactly as the contract names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Action {
    Inspect,
    Initialize,
    PlanAdoption,
    Preserve,
    Adopt,
    Baseline,
    Resume,
}

impl Action {
    pub const ALL: [Action; 7] = [
        Action::Inspect,
        Action::Initialize,
        Action::PlanAdoption,
        Action::Preserve,
        Action::Adopt,
        Action::Baseline,
        Action::Resume,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Action::Inspect => "inspect",
            Action::Initialize => "initialize",
            Action::PlanAdoption => "plan-adoption",
            Action::Preserve => "preserve",
            Action::Adopt => "adopt",
            Action::Baseline => "baseline",
            Action::Resume => "resume",
        }
    }

    /// Byte limit for this action's stdin request.
    pub fn request_limit(self) -> usize {
        match self {
            Action::Inspect | Action::Initialize | Action::PlanAdoption => ROOT_REQUEST_LIMIT,
            Action::Preserve | Action::Adopt | Action::Baseline | Action::Resume => {
                PHASE_REQUEST_LIMIT
            }
        }
    }

    /// Wall-clock bound after which the client stops waiting and kills the
    /// child. Baseline gets the plan's own upload deadline plus slack; the rest
    /// are local operations plus first-run package resolution.
    pub fn timeout(self) -> Duration {
        match self {
            Action::Baseline => Duration::from_millis(PLAN_MAX_DURATION_MS + 60_000),
            Action::PlanAdoption | Action::Preserve | Action::Adopt => {
                Duration::from_millis(PLAN_MAX_DURATION_MS)
            }
            Action::Inspect | Action::Initialize | Action::Resume => Duration::from_secs(120),
        }
    }

    /// argv after the package bin: `personal-projection ACTION --stdin-json`.
    pub fn argv(self) -> [&'static str; 3] {
        ["personal-projection", self.as_str(), "--stdin-json"]
    }
}

/// Typed pause reasons the wrapper may return. Exactly the contract set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PauseReason {
    AdoptionRequired,
    OwnerMismatch,
    AuthorityChanged,
    AuthorityUnavailable,
    StateUnreadable,
    StateChanged,
    RootReplaced,
    Busy,
    InvalidRequest,
    LeaseReleased,
}

impl PauseReason {
    pub fn expected_retryable(self) -> bool {
        matches!(self, PauseReason::Busy | PauseReason::AuthorityUnavailable)
    }

    pub fn expected_required_action(self) -> RequiredAction {
        match self {
            PauseReason::Busy => RequiredAction::RetryWhenIdle,
            PauseReason::AuthorityUnavailable => RequiredAction::RetryAuthority,
            PauseReason::AdoptionRequired => RequiredAction::ReviewAdoption,
            PauseReason::InvalidRequest => RequiredAction::CorrectRequest,
            _ => RequiredAction::ReviewRecovery,
        }
    }
}

/// `requiredAction` values from the contract's pause table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequiredAction {
    RetryWhenIdle,
    RetryAuthority,
    ReviewAdoption,
    CorrectRequest,
    ReviewRecovery,
}

/// Recovery steps attached to `adoption_required`. They are available steps,
/// not approval.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Recovery {
    pub schema_version: u32,
    pub commands: Vec<String>,
    pub approval_required: bool,
}

/// A typed pause read from the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WirePause {
    pub reason: PauseReason,
    pub retryable: bool,
    pub required_action: RequiredAction,
    pub recovery: Option<Recovery>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WirePauseBody {
    schema_version: u32,
    status: String,
    reason: PauseReason,
    retryable: bool,
    required_action: RequiredAction,
    #[serde(default)]
    recovery: Option<Recovery>,
}

/// Pauses that never come from the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LocalPause {
    /// The binary lacks the contract, is not the pinned artifact, or answered
    /// with something the contract does not allow. Show "Update HQ".
    UnsupportedCli,
    /// The user or an app quit cancelled the child. A late success is discarded.
    Cancelled,
    /// The child could not be started.
    SpawnFailed,
    /// The child did not finish within the action's bound and was killed.
    Timeout,
    /// The request was refused before spawning: a relative root, a request
    /// over the size limit, or an approval that does not match the plan.
    RequestRejected,
    /// The child wrote more than [`MAX_RESULT_BYTES`] and was killed.
    ResponseTooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pause {
    Wire(WirePause),
    Local(LocalPause),
}

impl Pause {
    /// True for a paused result whose reason is `adoption_required`.
    pub fn requires_adoption(&self) -> bool {
        matches!(self, Pause::Wire(p) if p.reason == PauseReason::AdoptionRequired)
    }

    /// Only `busy` and `authority_unavailable` may be retried, and only when
    /// the user asks. Local pauses are never retryable.
    pub fn retryable(&self) -> bool {
        matches!(self, Pause::Wire(p) if p.retryable)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome<T> {
    Done(T),
    Paused(Pause),
}

impl<T> Outcome<T> {
    fn local(reason: LocalPause) -> Self {
        Outcome::Paused(Pause::Local(reason))
    }
}

/// `inspect` statuses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InspectStatus {
    NewRoot,
    OwnerObserved,
    /// Returned with exit 3 and a status field (not necessarily `paused`).
    AdoptionRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InspectReport {
    pub status: InspectStatus,
    pub projection_id: Option<String>,
}

impl InspectReport {
    pub fn requires_adoption(&self) -> bool {
        self.status == InspectStatus::AdoptionRequired
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct InspectBody {
    schema_version: u32,
    status: String,
    #[serde(default)]
    projection_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Initialized {
    schema_version: u32,
    status: String,
    pub projection_id: String,
    pub root_path: String,
    pub journal_scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlanDestination {
    pub uid: String,
    pub bucket: String,
    pub endpoint: String,
    pub region: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UploadKind {
    File,
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UploadEntry {
    pub key: String,
    pub kind: UploadKind,
    pub local_hash: String,
    pub wire_hash: String,
    pub size: u64,
    pub wire_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PreservedEntry {
    pub key: String,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlanPermissions {
    pub upload: bool,
    pub remote_delete: bool,
    pub local_delete: bool,
    pub overwrite_existing: bool,
}

/// The adoption plan's typed view. Used to validate and display the plan;
/// the bytes sent back are always the verbatim [`ReviewedPlan::raw_json`].
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AdoptionPlan {
    pub schema_version: u32,
    pub transaction_id: String,
    pub root_path: String,
    pub state_directory: String,
    pub destination: PlanDestination,
    pub authority_digest: String,
    pub inventory_digest: String,
    pub approved_plan_digest: String,
    pub file_count: u64,
    pub byte_count: u64,
    pub historical_uids: Vec<String>,
    pub historical_bucket: String,
    pub upload_entries: Vec<UploadEntry>,
    pub preserved_only: Vec<PreservedEntry>,
    pub permissions: PlanPermissions,
    pub max_upload_rows: u64,
    pub max_upload_bytes: u64,
    pub max_duration_ms: u64,
    pub root_device: u64,
    pub root_inode: u64,
    pub state_device: Option<u64>,
    pub state_inode: Option<u64>,
}

impl AdoptionPlan {
    fn is_contract_shaped(&self) -> bool {
        self.schema_version == SCHEMA_VERSION
            && self.historical_bucket == "unknown"
            && self.max_duration_ms == PLAN_MAX_DURATION_MS
            && self.permissions
                == PlanPermissions {
                    upload: true,
                    remote_delete: false,
                    local_delete: false,
                    overwrite_existing: false,
                }
            && !self.approved_plan_digest.is_empty()
            && !self.transaction_id.is_empty()
    }
}

/// A plan exactly as `plan-adoption` returned it, plus its typed view.
#[derive(Debug, Clone)]
pub struct ReviewedPlan {
    raw: Box<RawValue>,
    plan: AdoptionPlan,
}

impl ReviewedPlan {
    /// The verbatim JSON the wrapper returned. Persist this, never a re-encoding.
    pub fn raw_json(&self) -> &str {
        self.raw.get()
    }

    pub fn plan(&self) -> &AdoptionPlan {
        &self.plan
    }

    /// Rebuild from bytes persisted earlier (for example after a relaunch).
    /// The bytes are kept as they are; only the typed view is re-derived.
    pub fn from_persisted(raw_json: &str) -> Option<Self> {
        let raw = RawValue::from_string(raw_json.to_string()).ok()?;
        let plan: AdoptionPlan = serde_json::from_str(raw.get()).ok()?;
        plan.is_contract_shaped().then_some(Self { raw, plan })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PlanBody {
    schema_version: u32,
    status: String,
    plan: Box<RawValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Preserved {
    schema_version: u32,
    status: String,
    pub transaction_id: String,
    pub approved_plan_digest: String,
    pub snapshot_directory: String,
    pub snapshot_digest: String,
    pub enrolled: bool,
    pub resumed: bool,
    pub state_device: u64,
    pub state_inode: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Adopted {
    schema_version: u32,
    status: String,
    pub projection_id: String,
    pub resumed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BaselineReady {
    schema_version: u32,
    status: String,
    pub projection_id: String,
    pub receipt_digest: String,
    pub resumed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ResumeAuthorized {
    schema_version: u32,
    status: String,
    pub projection_id: String,
    /// Always false: resume never starts a runner. The Desktop starts its own.
    pub runner_started: bool,
}

/// Adoption phases that each need their own user approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Preserve,
    Adopt,
    Baseline,
    Resume,
}

impl Phase {
    fn action(self) -> Action {
        match self {
            Phase::Preserve => Action::Preserve,
            Phase::Adopt => Action::Adopt,
            Phase::Baseline => Action::Baseline,
            Phase::Resume => Action::Resume,
        }
    }
}

/// One user approval for one phase of one plan. Built from a user action that
/// carried the plan digest the user saw. The client refuses it, without
/// spawning, when the phase or digest does not match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserApproval {
    pub phase: Phase,
    pub plan_digest: String,
}

/// Raw process result from a runner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutput {
    Exited {
        code: Option<i32>,
        stdout: Vec<u8>,
    },
    /// The configured artifact is not the pinned build, so nothing was spawned.
    ArtifactUnverified,
    SpawnFailed,
    Timeout,
    Cancelled,
    ResponseTooLarge,
}

/// How the client reaches the wrapper. Production spawns the pinned hq-cloud
/// artifact; tests inject a fake that records requests and replays output.
pub trait ProjectionRunner {
    fn run(&self, action: Action, stdin: &[u8]) -> RunOutput;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeState {
    NotProbed,
    Supported,
    Unsupported,
}

/// Client for one session. The first `inspect` is the feature probe.
pub struct PersonalProjectionClient<R: ProjectionRunner> {
    runner: R,
    probe: Mutex<ProbeState>,
}

impl<R: ProjectionRunner> PersonalProjectionClient<R> {
    pub fn new(runner: R) -> Self {
        Self {
            runner,
            probe: Mutex::new(ProbeState::NotProbed),
        }
    }

    fn probe_state(&self) -> ProbeState {
        *self.probe.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_probe_state(&self, state: ProbeState) {
        *self.probe.lock().unwrap_or_else(|e| e.into_inner()) = state;
    }

    /// Run `inspect` on `root_path`. The first call is the session's feature
    /// probe. The result never authorizes adoption, seeding, upload, or start.
    pub fn inspect(&self, root_path: &str) -> Outcome<InspectReport> {
        if self.probe_state() == ProbeState::Unsupported {
            return Outcome::local(LocalPause::UnsupportedCli);
        }
        let Some(request) = root_request(root_path) else {
            return Outcome::local(LocalPause::RequestRejected);
        };
        let outcome = match self.execute(Action::Inspect, &request) {
            Ok((code, stdout)) => classify_inspect(code, &stdout),
            Err(pause) => Outcome::local(pause),
        };
        match &outcome {
            Outcome::Done(_) | Outcome::Paused(Pause::Wire(_)) => {
                self.set_probe_state(ProbeState::Supported)
            }
            Outcome::Paused(Pause::Local(LocalPause::UnsupportedCli)) => {
                self.set_probe_state(ProbeState::Unsupported)
            }
            Outcome::Paused(Pause::Local(_)) => {}
        }
        outcome
    }

    /// Exclusively create a genuinely absent root and initialize its owner.
    /// `root_path` must be the canonical prospective root. A result naming any
    /// other root is treated as an unsupported binary.
    pub fn initialize(&self, root_path: &str) -> Outcome<Initialized> {
        if let Some(pause) = self.require_probe(root_path) {
            return Outcome::Paused(pause);
        }
        let Some(request) = root_request(root_path) else {
            return Outcome::local(LocalPause::RequestRejected);
        };
        self.run_and_classify(Action::Initialize, &request, |stdout| {
            let body: Initialized = serde_json::from_slice(stdout).ok()?;
            (body.schema_version == SCHEMA_VERSION
                && body.status == "initialized"
                && body.root_path == root_path
                && !body.projection_id.is_empty())
            .then_some(body)
        })
    }

    pub fn plan_adoption(&self, root_path: &str) -> Outcome<ReviewedPlan> {
        if let Some(pause) = self.require_probe(root_path) {
            return Outcome::Paused(pause);
        }
        let Some(request) = root_request(root_path) else {
            return Outcome::local(LocalPause::RequestRejected);
        };
        self.run_and_classify(Action::PlanAdoption, &request, |stdout| {
            let body: PlanBody = serde_json::from_slice(stdout).ok()?;
            if body.schema_version != SCHEMA_VERSION || body.status != "review_required" {
                return None;
            }
            let plan: AdoptionPlan = serde_json::from_str(body.plan.get()).ok()?;
            (plan.is_contract_shaped() && plan.root_path == root_path).then_some(ReviewedPlan {
                raw: body.plan,
                plan,
            })
        })
    }

    pub fn preserve(&self, plan: &ReviewedPlan, approval: &UserApproval) -> Outcome<Preserved> {
        self.phase(plan, approval, Phase::Preserve, None, |stdout| {
            let body: Preserved = serde_json::from_slice(stdout).ok()?;
            (body.schema_version == SCHEMA_VERSION
                && body.status == "preserved_pending_adoption"
                && body.transaction_id == plan.plan.transaction_id
                && body.approved_plan_digest == plan.plan.approved_plan_digest
                && !body.enrolled
                && !body.resumed)
                .then_some(body)
        })
    }

    pub fn adopt(&self, plan: &ReviewedPlan, approval: &UserApproval) -> Outcome<Adopted> {
        self.phase(plan, approval, Phase::Adopt, None, |stdout| {
            let body: Adopted = serde_json::from_slice(stdout).ok()?;
            (body.schema_version == SCHEMA_VERSION
                && body.status == "adopted_pending_baseline"
                && !body.resumed
                && !body.projection_id.is_empty())
            .then_some(body)
        })
    }

    pub fn baseline(&self, plan: &ReviewedPlan, approval: &UserApproval) -> Outcome<BaselineReady> {
        self.phase(plan, approval, Phase::Baseline, None, |stdout| {
            let body: BaselineReady = serde_json::from_slice(stdout).ok()?;
            (body.schema_version == SCHEMA_VERSION
                && body.status == "baseline_ready"
                && !body.resumed
                && !body.receipt_digest.is_empty())
            .then_some(body)
        })
    }

    /// Authorize later ordinary operation. Never starts a runner; the caller
    /// starts the Desktop's own runner once, after this returns.
    pub fn resume(
        &self,
        plan: &ReviewedPlan,
        approval: &UserApproval,
        baseline: &BaselineReady,
    ) -> Outcome<ResumeAuthorized> {
        self.phase(
            plan,
            approval,
            Phase::Resume,
            Some(&baseline.receipt_digest),
            |stdout| {
                let body: ResumeAuthorized = serde_json::from_slice(stdout).ok()?;
                (body.schema_version == SCHEMA_VERSION
                    && body.status == "resume_authorized"
                    && !body.runner_started
                    && body.projection_id == baseline.projection_id)
                    .then_some(body)
            },
        )
    }

    fn phase<T>(
        &self,
        plan: &ReviewedPlan,
        approval: &UserApproval,
        phase: Phase,
        receipt_digest: Option<&str>,
        parse: impl FnOnce(&[u8]) -> Option<T>,
    ) -> Outcome<T> {
        if approval.phase != phase || approval.plan_digest != plan.plan.approved_plan_digest {
            return Outcome::local(LocalPause::RequestRejected);
        }
        if let Some(pause) = self.require_probe(&plan.plan.root_path) {
            return Outcome::Paused(pause);
        }
        let Some(request) = phase_request(plan, phase, receipt_digest) else {
            return Outcome::local(LocalPause::RequestRejected);
        };
        self.run_and_classify(phase.action(), &request, parse)
    }

    /// Run the feature probe once per session before any non-inspect action.
    fn require_probe(&self, root_path: &str) -> Option<Pause> {
        match self.probe_state() {
            ProbeState::Supported => None,
            ProbeState::Unsupported => Some(Pause::Local(LocalPause::UnsupportedCli)),
            ProbeState::NotProbed => match self.inspect(root_path) {
                Outcome::Done(_) | Outcome::Paused(Pause::Wire(_)) => None,
                Outcome::Paused(local) => Some(local),
            },
        }
    }

    fn execute(
        &self,
        action: Action,
        request: &[u8],
    ) -> Result<(Option<i32>, Vec<u8>), LocalPause> {
        if request.len() > action.request_limit() {
            return Err(LocalPause::RequestRejected);
        }
        match self.runner.run(action, request) {
            RunOutput::Exited { code, stdout } => Ok((code, stdout)),
            RunOutput::ArtifactUnverified => Err(LocalPause::UnsupportedCli),
            RunOutput::SpawnFailed => Err(LocalPause::SpawnFailed),
            RunOutput::Timeout => Err(LocalPause::Timeout),
            RunOutput::Cancelled => Err(LocalPause::Cancelled),
            RunOutput::ResponseTooLarge => Err(LocalPause::ResponseTooLarge),
        }
    }

    fn run_and_classify<T>(
        &self,
        action: Action,
        request: &[u8],
        parse: impl FnOnce(&[u8]) -> Option<T>,
    ) -> Outcome<T> {
        let (code, stdout) = match self.execute(action, request) {
            Ok(output) => output,
            Err(pause) => {
                if pause == LocalPause::UnsupportedCli {
                    self.set_probe_state(ProbeState::Unsupported);
                }
                return Outcome::local(pause);
            }
        };
        let outcome = classify_action(code, &stdout, parse);
        if matches!(
            outcome,
            Outcome::Paused(Pause::Local(LocalPause::UnsupportedCli))
        ) {
            self.set_probe_state(ProbeState::Unsupported);
        }
        outcome
    }
}

fn root_request(root_path: &str) -> Option<Vec<u8>> {
    if !std::path::Path::new(root_path).is_absolute() {
        return None;
    }
    serde_json::to_vec(&serde_json::json!({
        "schemaVersion": SCHEMA_VERSION,
        "rootPath": root_path,
    }))
    .ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseRequest<'a> {
    schema_version: u32,
    plan: &'a RawValue,
    approval: serde_json::Value,
}

fn phase_request(
    plan: &ReviewedPlan,
    phase: Phase,
    receipt_digest: Option<&str>,
) -> Option<Vec<u8>> {
    let digest = plan.plan.approved_plan_digest.as_str();
    let approval = match phase {
        Phase::Preserve => serde_json::json!({ "planDigest": digest }),
        Phase::Adopt => serde_json::json!({
            "planDigest": digest,
            "disposition": ADOPT_DISPOSITION,
        }),
        Phase::Baseline => serde_json::json!({
            "planDigest": digest,
            "disposition": BASELINE_DISPOSITION,
        }),
        Phase::Resume => serde_json::json!({
            "planDigest": digest,
            "receiptDigest": receipt_digest?,
            "disposition": RESUME_DISPOSITION,
        }),
    };
    serde_json::to_vec(&PhaseRequest {
        schema_version: SCHEMA_VERSION,
        plan: &plan.raw,
        approval,
    })
    .ok()
}

/// The `status` field of a JSON object, or `None` for anything else.
fn top_level_status(stdout: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(stdout).ok()?;
    value
        .as_object()?
        .get("status")?
        .as_str()
        .map(str::to_string)
}

/// A typed pause, checked against the contract table and the exit code.
fn classify_pause(code: Option<i32>, stdout: &[u8]) -> Option<WirePause> {
    let body: WirePauseBody = serde_json::from_slice(stdout).ok()?;
    if body.schema_version != SCHEMA_VERSION
        || body.status != "paused"
        || body.retryable != body.reason.expected_retryable()
        || body.required_action != body.reason.expected_required_action()
    {
        return None;
    }
    let expected_exit = if body.reason == PauseReason::InvalidRequest {
        2
    } else {
        3
    };
    if code != Some(expected_exit) {
        return None;
    }
    match (&body.recovery, body.reason) {
        (None, _) => {}
        (Some(recovery), PauseReason::AdoptionRequired)
            if recovery.schema_version == SCHEMA_VERSION && recovery.approval_required => {}
        _ => return None,
    }
    Some(WirePause {
        reason: body.reason,
        retryable: body.retryable,
        required_action: body.required_action,
        recovery: body.recovery,
    })
}

fn classify_action<T>(
    code: Option<i32>,
    stdout: &[u8],
    parse: impl FnOnce(&[u8]) -> Option<T>,
) -> Outcome<T> {
    match top_level_status(stdout).as_deref() {
        Some("paused") => match classify_pause(code, stdout) {
            Some(pause) => Outcome::Paused(Pause::Wire(pause)),
            None => Outcome::local(LocalPause::UnsupportedCli),
        },
        Some(_) if code == Some(0) => match parse(stdout) {
            Some(done) => Outcome::Done(done),
            None => Outcome::local(LocalPause::UnsupportedCli),
        },
        _ => Outcome::local(LocalPause::UnsupportedCli),
    }
}

fn classify_inspect(code: Option<i32>, stdout: &[u8]) -> Outcome<InspectReport> {
    if top_level_status(stdout).as_deref() == Some("paused") {
        return classify_action(code, stdout, |_| None::<InspectReport>);
    }
    let Ok(body) = serde_json::from_slice::<InspectBody>(stdout) else {
        return Outcome::local(LocalPause::UnsupportedCli);
    };
    if body.schema_version != SCHEMA_VERSION {
        return Outcome::local(LocalPause::UnsupportedCli);
    }
    let status = match (body.status.as_str(), code) {
        ("new_root", Some(0)) => InspectStatus::NewRoot,
        ("owner_observed", Some(0)) => InspectStatus::OwnerObserved,
        ("adoption_required", Some(3)) => InspectStatus::AdoptionRequired,
        _ => return Outcome::local(LocalPause::UnsupportedCli),
    };
    Outcome::Done(InspectReport {
        status,
        projection_id: body.projection_id,
    })
}

/// Spawn one wrapper invocation with bounded stdin, stdout, and wall clock.
///
/// The program and argv stay structured (no shell). stdin carries the whole
/// request. stderr is discarded so no raw diagnostics are kept. A set `cancel`
/// flag kills the child, and a cancel observed after the child exits still
/// discards its result as [`RunOutput::Cancelled`].
pub fn run_bounded(
    mut command: std::process::Command,
    stdin: &[u8],
    timeout: Duration,
    cancel: Option<&AtomicBool>,
) -> RunOutput {
    let is_cancelled = || cancel.is_some_and(|flag| flag.load(Ordering::Acquire));
    if is_cancelled() {
        return RunOutput::Cancelled;
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return RunOutput::SpawnFailed,
    };

    let request = stdin.to_vec();
    let child_stdin = child.stdin.take();
    let writer = std::thread::spawn(move || {
        if let Some(mut pipe) = child_stdin {
            let _ = pipe.write_all(&request);
        }
    });

    let child_stdout = child.stdout.take();
    let reader = std::thread::spawn(move || -> (Vec<u8>, bool) {
        let mut out = Vec::new();
        let Some(pipe) = child_stdout else {
            return (out, false);
        };
        let mut limited = pipe.take(MAX_RESULT_BYTES as u64 + 1);
        let _ = limited.read_to_end(&mut out);
        let too_large = out.len() > MAX_RESULT_BYTES;
        (out, too_large)
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        let stop = if is_cancelled() {
            Some(RunOutput::Cancelled)
        } else if started.elapsed() >= timeout {
            Some(RunOutput::Timeout)
        } else if reader.is_finished() {
            // The reader only returns early when stdout closed or hit the cap.
            // A capped child is killed now instead of waiting for its timeout.
            None
        } else {
            None
        };
        if let Some(stop) = stop {
            kill_tree(&mut child);
            let _ = writer.join();
            let _ = reader.join();
            return stop;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let _ = writer.join();
    let (stdout, too_large) = reader.join().unwrap_or_default();
    if is_cancelled() {
        return RunOutput::Cancelled;
    }
    if too_large {
        return RunOutput::ResponseTooLarge;
    }
    let Some(status) = status else {
        return RunOutput::SpawnFailed;
    };
    RunOutput::Exited {
        code: status.code(),
        stdout,
    }
}

fn kill_tree(child: &mut std::process::Child) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        // The child leads its own process group, so this also reaches the node
        // process npx starts.
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: plain signal delivery to a process group this call created.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Production runner: `npx -y --package=@indigoai-us/hq-cloud@<exact> hq-cloud
/// personal-projection ACTION --stdin-json`, through the same npx program and
/// child PATH the sync runner uses.
pub struct NpxProjectionRunner {
    package_spec: String,
    cancel: Arc<AtomicBool>,
}

impl NpxProjectionRunner {
    pub(crate) fn for_exact_version(version: &str) -> Self {
        Self {
            package_spec: format!("{}@{}", crate::hq_cloud::HQ_CLOUD_PACKAGE, version),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Flag that cancels the running child when set.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    /// The argv after the `npx` program for one action.
    pub fn npx_args(&self, action: Action) -> Vec<String> {
        let mut args = vec![
            "-y".to_string(),
            format!("--package={}", self.package_spec),
            PROJECTION_BIN.to_string(),
        ];
        args.extend(action.argv().iter().map(|arg| arg.to_string()));
        args
    }
}

impl ProjectionRunner for NpxProjectionRunner {
    fn run(&self, action: Action, stdin: &[u8]) -> RunOutput {
        let npx = crate::paths::resolve_bin("npx");
        let args = self.npx_args(action);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut command = crate::paths::spawn_command(&npx, &arg_refs);
        command.env("PATH", crate::paths::child_path());
        run_bounded(command, stdin, action.timeout(), Some(&self.cancel))
    }
}

#[cfg(test)]
#[path = "personal_projection_tests.rs"]
mod tests;
