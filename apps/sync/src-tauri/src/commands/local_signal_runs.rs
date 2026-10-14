//! signals-local-meetings-v1 US-002 — durable, session-scoped run contract for
//! the Meetings "Generate signals" action.
//!
//! One JSON record per job under `<data>/HQ/local-signal-runs/<account>/`.
//! Every mutation after the request is keyed by job ID AND the provider session
//! ID that claimed it, so two interactive sessions can never advance, cancel,
//! or recover each other's run. The parsed model result is stored beside the
//! record; once it exists, recovery resumes at `writing` and never asks for a
//! second model call.
//!
//! This module never spawns a model process. A run with no compatible
//! interactive Claude or Codex session stays `pending`; there is no cloud or
//! headless fallback.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
use tokio::sync::Mutex;

pub const RUN_REQUEST_SCHEMA: &str = "hq-local-signal-run/v1";
const MAX_RUNS: usize = 2000;
const MAX_STATUS_CHARS: usize = 160;
const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;
const MAX_HISTORY: usize = 64;
static LOCK: OnceLock<Arc<Mutex<()>>> = OnceLock::new();

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

/// The member's provider choice on the request. `Any` lets whichever
/// compatible interactive session is open claim it.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderChoice {
    Claude,
    Codex,
    Any,
}

impl ProviderChoice {
    fn accepts(self, p: Provider) -> bool {
        matches!(
            (self, p),
            (ProviderChoice::Any, _)
                | (ProviderChoice::Claude, Provider::Claude)
                | (ProviderChoice::Codex, Provider::Codex)
        )
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunState {
    Pending,
    Claimed,
    Extracting,
    Writing,
    Uploading,
    Complete,
    Cancelled,
    Failed,
}

impl RunState {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            RunState::Complete | RunState::Cancelled | RunState::Failed
        )
    }
    fn is_active(self) -> bool {
        matches!(
            self,
            RunState::Claimed | RunState::Extracting | RunState::Writing | RunState::Uploading
        )
    }
    fn rank(self) -> u8 {
        match self {
            RunState::Pending => 0,
            RunState::Claimed => 1,
            RunState::Extracting => 2,
            RunState::Writing => 3,
            RunState::Uploading => 4,
            RunState::Complete => 5,
            RunState::Cancelled | RunState::Failed => 6,
        }
    }
    pub fn default_status(self) -> &'static str {
        match self {
            RunState::Pending => "Waiting for an open Claude or Codex session.",
            RunState::Claimed => "A session picked up the request.",
            RunState::Extracting => "Reading the transcript.",
            RunState::Writing => "Saving signals on this device.",
            RunState::Uploading => "Sharing sanitized signals with your company.",
            RunState::Complete => "Signals ready.",
            RunState::Cancelled => "Cancelled.",
            RunState::Failed => "Signal generation failed.",
        }
    }
}

/// What the Meetings action submits. The job ID is minted here, not by the
/// caller.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequestInput {
    pub company_uid: String,
    pub member_uid: String,
    pub source_ref: String,
    pub source_digest: String,
    pub audience_receipt_ref: String,
    pub provider: ProviderChoice,
    pub prompt_version: String,
    pub schema_version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRequest {
    pub schema: String,
    pub job_id: String,
    pub company_uid: String,
    pub member_uid: String,
    pub source_ref: String,
    pub source_digest: String,
    pub audience_receipt_ref: String,
    pub provider: ProviderChoice,
    pub prompt_version: String,
    pub schema_version: String,
    pub dedupe_key: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transition {
    pub state: RunState,
    pub at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunRecord {
    pub request: RunRequest,
    pub state: RunState,
    pub status: String,
    pub history: Vec<Transition>,
    pub updated_at: String,
    #[serde(default)]
    pub claimed_by: Option<Provider>,
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub owner_pid: Option<u32>,
    /// sha256 of the stored parsed result; present means no further model call.
    #[serde(default)]
    pub parsed_result_digest: Option<String>,
    /// Number of button activations that resolved to this job.
    pub activations: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSession {
    pub provider: Provider,
    pub session_id: String,
    pub interactive: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResumePlan {
    pub record: RunRecord,
    /// False once a parsed result is stored: the session must not call the model.
    pub needs_model_call: bool,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn bounded_status(s: &str) -> String {
    let clean: String = s.chars().filter(|c| !c.is_control()).collect();
    let trimmed = clean.trim();
    if trimmed.chars().count() <= MAX_STATUS_CHARS {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(MAX_STATUS_CHARS - 1).collect();
    out.push('…');
    out
}

fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && !s.chars().any(|c| c.is_control())
}

fn valid_job_id(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

impl RunRequestInput {
    fn validate(&self) -> Result<(), String> {
        for v in [
            &self.company_uid,
            &self.member_uid,
            &self.source_ref,
            &self.source_digest,
            &self.audience_receipt_ref,
            &self.prompt_version,
            &self.schema_version,
        ] {
            if !valid_id(v) {
                return Err("Invalid signal run request".into());
            }
        }
        Ok(())
    }
    /// Same member + source + digest + versions → same job.
    pub fn dedupe_key(&self) -> String {
        let mut h = Sha256::new();
        for part in [
            RUN_REQUEST_SCHEMA,
            &self.company_uid,
            &self.member_uid,
            &self.source_ref,
            &self.source_digest,
            &self.prompt_version,
            &self.schema_version,
        ] {
            h.update(part.as_bytes());
            h.update([0u8]);
        }
        hex(&h.finalize())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn record_path(dir: &Path, job_id: &str) -> PathBuf {
    dir.join(format!("{job_id}.json"))
}
fn result_path(dir: &Path, job_id: &str) -> PathBuf {
    dir.join(format!("{job_id}.result.json"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid run path")?;
    std::fs::create_dir_all(dir).map_err(|_| "Cannot create run directory")?;
    let tmp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err("Cannot write run".into());
    }
    Ok(())
}

fn save(dir: &Path, rec: &RunRecord) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(rec).map_err(|_| "Cannot encode run")?;
    write_atomic(&record_path(dir, &rec.request.job_id), &bytes)
}

pub fn load(dir: &Path, job_id: &str) -> Result<RunRecord, String> {
    if !valid_job_id(job_id) {
        return Err("Unknown signal run".into());
    }
    let bytes = std::fs::read(record_path(dir, job_id)).map_err(|_| "Unknown signal run")?;
    serde_json::from_slice(&bytes).map_err(|_| "Corrupt signal run".into())
}

pub fn list(dir: &Path) -> Result<Vec<RunRecord>, String> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Cannot read signal runs".into()),
    };
    let mut out = Vec::new();
    for entry in entries.flatten().take(MAX_RUNS * 2) {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(job) = name.strip_suffix(".json") else {
            continue;
        };
        if job.ends_with(".result") || !valid_job_id(job) {
            continue;
        }
        if let Ok(rec) = load(dir, job) {
            out.push(rec);
        }
    }
    out.sort_by(|a, b| a.request.created_at.cmp(&b.request.created_at));
    Ok(out)
}

fn transition(rec: &mut RunRecord, state: RunState, status: Option<&str>) {
    let at = now();
    rec.state = state;
    rec.status = bounded_status(status.unwrap_or(state.default_status()));
    rec.updated_at = at.clone();
    rec.history.push(Transition { state, at });
    if rec.history.len() > MAX_HISTORY {
        let drop = rec.history.len() - MAX_HISTORY;
        rec.history.drain(0..drop);
    }
}

fn release_owner(rec: &mut RunRecord) {
    rec.claimed_by = None;
    rec.provider_session_id = None;
    rec.owner_pid = None;
}

/// One call per button activation. Reuses the job when the source digest and
/// versions are unchanged; a cancelled or failed job is re-queued in place and
/// keeps any stored parsed result.
pub fn request(dir: &Path, input: RunRequestInput) -> Result<RunRecord, String> {
    input.validate()?;
    let key = input.dedupe_key();
    let runs = list(dir)?;
    if let Some(mut rec) = runs.into_iter().find(|r| r.request.dedupe_key == key) {
        rec.activations = rec.activations.saturating_add(1);
        if matches!(rec.state, RunState::Cancelled | RunState::Failed) {
            release_owner(&mut rec);
            transition(&mut rec, RunState::Pending, None);
        }
        save(dir, &rec)?;
        return Ok(rec);
    }
    if list(dir)?.len() >= MAX_RUNS {
        return Err("Too many signal runs on this device".into());
    }
    let at = now();
    let request = RunRequest {
        schema: RUN_REQUEST_SCHEMA.into(),
        job_id: uuid::Uuid::new_v4().to_string(),
        company_uid: input.company_uid,
        member_uid: input.member_uid,
        source_ref: input.source_ref,
        source_digest: input.source_digest,
        audience_receipt_ref: input.audience_receipt_ref,
        provider: input.provider,
        prompt_version: input.prompt_version,
        schema_version: input.schema_version,
        dedupe_key: key,
        created_at: at.clone(),
    };
    let rec = RunRecord {
        request,
        state: RunState::Pending,
        status: bounded_status(RunState::Pending.default_status()),
        history: vec![Transition {
            state: RunState::Pending,
            at: at.clone(),
        }],
        updated_at: at,
        claimed_by: None,
        provider_session_id: None,
        owner_pid: None,
        parsed_result_digest: None,
        activations: 1,
    };
    save(dir, &rec)?;
    Ok(rec)
}

/// Picks the session that may claim this run. `None` means the run stays
/// pending; there is deliberately no fallback.
pub fn compatible_session<'a>(
    rec: &RunRecord,
    sessions: &'a [ProviderSession],
) -> Option<&'a ProviderSession> {
    sessions.iter().find(|s| {
        s.interactive && valid_id(&s.session_id) && rec.request.provider.accepts(s.provider)
    })
}

/// Claim a pending run for one interactive session.
pub fn claim(
    dir: &Path,
    job_id: &str,
    session: &ProviderSession,
    pid: Option<u32>,
) -> Result<RunRecord, String> {
    let mut rec = load(dir, job_id)?;
    if !session.interactive || !valid_id(&session.session_id) {
        return Err("Only an interactive session can claim a signal run".into());
    }
    if !rec.request.provider.accepts(session.provider) {
        return Err("This run asked for a different provider".into());
    }
    if rec.state != RunState::Pending {
        return Err("Signal run is not waiting to be claimed".into());
    }
    rec.claimed_by = Some(session.provider);
    rec.provider_session_id = Some(session.session_id.clone());
    rec.owner_pid = pid;
    transition(&mut rec, RunState::Claimed, None);
    save(dir, &rec)?;
    Ok(rec)
}

fn require_owner(rec: &RunRecord, session_id: &str) -> Result<(), String> {
    if rec.provider_session_id.as_deref() != Some(session_id) {
        return Err("Signal run belongs to another session".into());
    }
    Ok(())
}

/// Forward-only progress by the owning session.
pub fn progress(
    dir: &Path,
    job_id: &str,
    session_id: &str,
    state: RunState,
    status: Option<&str>,
) -> Result<RunRecord, String> {
    let mut rec = load(dir, job_id)?;
    require_owner(&rec, session_id)?;
    if rec.state.is_terminal() {
        return Err("Signal run already finished".into());
    }
    if matches!(
        state,
        RunState::Pending | RunState::Claimed | RunState::Cancelled
    ) {
        return Err("Use claim or cancel for that state".into());
    }
    if state != RunState::Failed && state.rank() < rec.state.rank() {
        return Err("Signal run cannot move backwards".into());
    }
    if state.rank() >= RunState::Writing.rank()
        && state != RunState::Failed
        && rec.parsed_result_digest.is_none()
    {
        return Err("Store the parsed result before writing".into());
    }
    if state.is_terminal() {
        rec.owner_pid = None;
    }
    transition(&mut rec, state, status);
    save(dir, &rec)?;
    Ok(rec)
}

/// Durably store the parsed model output. Idempotent for identical bytes; a
/// different second result is refused so the first parse is authoritative.
pub fn store_parsed_result(
    dir: &Path,
    job_id: &str,
    session_id: &str,
    result: &serde_json::Value,
) -> Result<RunRecord, String> {
    let mut rec = load(dir, job_id)?;
    require_owner(&rec, session_id)?;
    if rec.state != RunState::Extracting {
        return Err("Parsed results are stored while extracting".into());
    }
    let bytes = serde_json::to_vec(result).map_err(|_| "Cannot encode result")?;
    if bytes.len() > MAX_RESULT_BYTES {
        return Err("Parsed result is too large".into());
    }
    let digest = hex(&Sha256::digest(&bytes));
    match &rec.parsed_result_digest {
        Some(d) if *d == digest => return Ok(rec),
        Some(_) => return Err("A parsed result is already stored".into()),
        None => {}
    }
    write_atomic(&result_path(dir, job_id), &bytes)?;
    rec.parsed_result_digest = Some(digest);
    rec.updated_at = now();
    save(dir, &rec)?;
    Ok(rec)
}

pub fn read_parsed_result(dir: &Path, job_id: &str) -> Result<Option<serde_json::Value>, String> {
    let rec = load(dir, job_id)?;
    let Some(digest) = rec.parsed_result_digest else {
        return Ok(None);
    };
    let bytes = std::fs::read(result_path(dir, job_id)).map_err(|_| "Stored result missing")?;
    if hex(&Sha256::digest(&bytes)) != digest {
        return Err("Stored result does not match its digest".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Corrupt stored result".into())
}

/// Cancel from the UI (`session_id = None`) or by the owning session. A
/// session cannot cancel a run another session owns.
pub fn cancel(dir: &Path, job_id: &str, session_id: Option<&str>) -> Result<RunRecord, String> {
    let mut rec = load(dir, job_id)?;
    if let Some(sid) = session_id {
        if rec.provider_session_id.is_some() {
            require_owner(&rec, sid)?;
        }
    }
    if rec.state.is_terminal() {
        return Ok(rec);
    }
    // Ownership is released; the session sees `cancelled` on its next progress call.
    release_owner(&mut rec);
    transition(&mut rec, RunState::Cancelled, None);
    save(dir, &rec)?;
    Ok(rec)
}

/// signals-local-meetings-v1 US-007: the provider session logged out or its
/// transport dropped. The owner is released so any compatible session can
/// recover the run. Without a stored parse the run goes back to `pending`;
/// with one it keeps its stage. `status` must be plain member-facing text.
pub fn release_for_provider_loss(
    dir: &Path,
    job_id: &str,
    session_id: &str,
    status: &str,
) -> Result<RunRecord, String> {
    let mut rec = load(dir, job_id)?;
    if rec.provider_session_id.is_some() {
        require_owner(&rec, session_id)?;
    }
    if rec.state.is_terminal() && rec.state != RunState::Failed {
        return Ok(rec);
    }
    release_owner(&mut rec);
    let state = if rec.parsed_result_digest.is_none() {
        RunState::Pending
    } else {
        rec.state
    };
    transition(&mut rec, state, Some(status));
    save(dir, &rec)?;
    Ok(rec)
}

/// Resume an interrupted or cancelled run for `session`. Allowed when the run
/// is pending/cancelled, when this session already owns it, or when the
/// previous owner process is gone. After a parsed result is stored the plan
/// resumes at `writing` with `needs_model_call = false`.
pub fn recover(
    dir: &Path,
    job_id: &str,
    session: &ProviderSession,
    pid: Option<u32>,
    owner_alive: impl Fn(u32) -> bool,
) -> Result<ResumePlan, String> {
    let mut rec = load(dir, job_id)?;
    if !session.interactive || !rec.request.provider.accepts(session.provider) {
        return Err("No compatible interactive session for this run".into());
    }
    if rec.state == RunState::Complete {
        return Ok(ResumePlan {
            record: rec,
            needs_model_call: false,
        });
    }
    let own = rec.provider_session_id.as_deref() == Some(session.session_id.as_str());
    if rec.state.is_active() && !own {
        let orphaned = match rec.owner_pid {
            Some(p) => !owner_alive(p),
            None => true,
        };
        if !orphaned {
            return Err("Signal run belongs to another session".into());
        }
    }
    rec.claimed_by = Some(session.provider);
    rec.provider_session_id = Some(session.session_id.clone());
    rec.owner_pid = pid;
    let resume_at = if rec.parsed_result_digest.is_some() {
        // Never move backwards past a stored parse.
        if rec.state == RunState::Uploading {
            RunState::Uploading
        } else {
            RunState::Writing
        }
    } else {
        RunState::Claimed
    };
    transition(&mut rec, resume_at, Some("Resuming from saved progress."));
    save(dir, &rec)?;
    Ok(ResumePlan {
        needs_model_call: rec.parsed_result_digest.is_none(),
        record: rec,
    })
}

// ── Tauri commands ───────────────────────────────────────────────────────────

pub(crate) fn runs_dir(account_id: &str) -> Result<PathBuf, String> {
    if !valid_id(account_id) {
        return Err("Invalid account".into());
    }
    let digest = hex(&Sha256::digest(account_id.as_bytes()));
    Ok(dirs::data_dir()
        .ok_or("Cannot resolve application data")?
        .join("HQ/local-signal-runs")
        .join(&digest[..32]))
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // Signal 0 checks existence without delivering anything. EPERM still means alive.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    // Conservative: without a liveness probe, treat the owner as alive so a
    // second session cannot take the run; the member can still cancel + resume.
    true
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let guard = LOCK
        .get_or_init(|| Arc::new(Mutex::new(())))
        .clone()
        .lock_owned()
        .await;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        f()
    })
    .await
    .map_err(|_| "Signal run worker failed".to_string())?
}

#[tauri::command]
pub async fn local_signal_run_request(
    account_id: String,
    input: RunRequestInput,
) -> Result<RunRecord, String> {
    let dir = runs_dir(&account_id)?;
    blocking(move || request(&dir, input)).await
}

#[tauri::command]
pub async fn local_signal_run_get(account_id: String, job_id: String) -> Result<RunRecord, String> {
    let dir = runs_dir(&account_id)?;
    blocking(move || load(&dir, &job_id)).await
}

#[tauri::command]
pub async fn local_signal_run_list(account_id: String) -> Result<Vec<RunRecord>, String> {
    let dir = runs_dir(&account_id)?;
    blocking(move || list(&dir)).await
}

/// Hand a pending run to the first compatible interactive session, or leave
/// it pending. Never starts a process or a cloud/headless fallback.
pub fn dispatch(
    dir: &Path,
    job_id: &str,
    sessions: &[ProviderSession],
) -> Result<RunRecord, String> {
    let rec = load(dir, job_id)?;
    if rec.state != RunState::Pending {
        return Ok(rec);
    }
    match compatible_session(&rec, sessions) {
        Some(s) => claim(dir, job_id, s, None),
        None => Ok(rec),
    }
}

#[tauri::command]
pub async fn local_signal_run_dispatch(
    account_id: String,
    job_id: String,
    sessions: Vec<ProviderSession>,
) -> Result<RunRecord, String> {
    let dir = runs_dir(&account_id)?;
    blocking(move || dispatch(&dir, &job_id, &sessions)).await
}

#[tauri::command]
pub async fn local_signal_run_result(
    account_id: String,
    job_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let dir = runs_dir(&account_id)?;
    blocking(move || read_parsed_result(&dir, &job_id)).await
}

#[tauri::command]
pub async fn local_signal_run_claim(
    account_id: String,
    job_id: String,
    session: ProviderSession,
    pid: Option<u32>,
) -> Result<RunRecord, String> {
    let dir = runs_dir(&account_id)?;
    blocking(move || claim(&dir, &job_id, &session, pid)).await
}

#[tauri::command]
pub async fn local_signal_run_progress(
    account_id: String,
    job_id: String,
    session_id: String,
    state: RunState,
    status: Option<String>,
) -> Result<RunRecord, String> {
    let dir = runs_dir(&account_id)?;
    blocking(move || progress(&dir, &job_id, &session_id, state, status.as_deref())).await
}

#[tauri::command]
pub async fn local_signal_run_store_result(
    account_id: String,
    job_id: String,
    session_id: String,
    result: serde_json::Value,
) -> Result<RunRecord, String> {
    let dir = runs_dir(&account_id)?;
    blocking(move || store_parsed_result(&dir, &job_id, &session_id, &result)).await
}

#[tauri::command]
pub async fn local_signal_run_cancel(
    account_id: String,
    job_id: String,
    session_id: Option<String>,
) -> Result<RunRecord, String> {
    let dir = runs_dir(&account_id)?;
    blocking(move || cancel(&dir, &job_id, session_id.as_deref())).await
}

#[tauri::command]
pub async fn local_signal_run_recover(
    account_id: String,
    job_id: String,
    session: ProviderSession,
    pid: Option<u32>,
) -> Result<ResumePlan, String> {
    let dir = runs_dir(&account_id)?;
    blocking(move || recover(&dir, &job_id, &session, pid, pid_alive)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> RunRequestInput {
        RunRequestInput {
            company_uid: "cmp_1".into(),
            member_uid: "prs_1".into(),
            source_ref: "sources/meetings/m1.md".into(),
            source_digest: "d1".into(),
            audience_receipt_ref: "receipts/a1.json".into(),
            provider: ProviderChoice::Any,
            prompt_version: "p1".into(),
            schema_version: "s1".into(),
        }
    }
    fn sess(p: Provider, id: &str) -> ProviderSession {
        ProviderSession {
            provider: p,
            session_id: id.into(),
            interactive: true,
        }
    }
    fn to_extracting(dir: &Path, job: &str, sid: &str) {
        claim(dir, job, &sess(Provider::Claude, sid), Some(1)).unwrap();
        progress(dir, job, sid, RunState::Extracting, None).unwrap();
    }

    #[test]
    fn request_records_every_field_with_unique_job_id() {
        let d = tempfile::tempdir().unwrap();
        let a = request(d.path(), input()).unwrap();
        let r = &a.request;
        assert_eq!(r.schema, RUN_REQUEST_SCHEMA);
        assert_eq!(
            (r.company_uid.as_str(), r.member_uid.as_str()),
            ("cmp_1", "prs_1")
        );
        assert_eq!(r.source_ref, "sources/meetings/m1.md");
        assert_eq!(r.source_digest, "d1");
        assert_eq!(r.audience_receipt_ref, "receipts/a1.json");
        assert_eq!(r.provider, ProviderChoice::Any);
        assert_eq!(
            (r.prompt_version.as_str(), r.schema_version.as_str()),
            ("p1", "s1")
        );
        assert!(valid_job_id(&r.job_id));
        let mut other = input();
        other.source_ref = "sources/meetings/m2.md".into();
        assert_ne!(request(d.path(), other).unwrap().request.job_id, r.job_id);
    }

    #[test]
    fn unknown_request_fields_are_rejected() {
        let mut v = serde_json::to_value(input()).unwrap();
        v["jobId"] = "caller-minted".into();
        assert!(serde_json::from_value::<RunRequestInput>(v).is_err());
    }

    #[test]
    fn activation_reuses_job_until_digest_or_version_changes() {
        let d = tempfile::tempdir().unwrap();
        let a = request(d.path(), input()).unwrap();
        let b = request(d.path(), input()).unwrap();
        assert_eq!(a.request.job_id, b.request.job_id);
        assert_eq!(b.activations, 2);
        assert_eq!(list(d.path()).unwrap().len(), 1);
        for change in 0..3 {
            let mut i = input();
            match change {
                0 => i.source_digest = "d2".into(),
                1 => i.prompt_version = "p2".into(),
                _ => i.schema_version = "s2".into(),
            }
            assert_ne!(
                request(d.path(), i).unwrap().request.job_id,
                a.request.job_id
            );
        }
        assert_eq!(list(d.path()).unwrap().len(), 4);
    }

    #[test]
    fn states_carry_timestamps_and_bounded_status() {
        let d = tempfile::tempdir().unwrap();
        let job = request(d.path(), input()).unwrap().request.job_id;
        to_extracting(d.path(), &job, "s1");
        store_parsed_result(d.path(), &job, "s1", &serde_json::json!({"signals": []})).unwrap();
        let long = "x".repeat(500);
        progress(d.path(), &job, "s1", RunState::Writing, Some(&long)).unwrap();
        progress(d.path(), &job, "s1", RunState::Uploading, None).unwrap();
        let rec = progress(d.path(), &job, "s1", RunState::Complete, None).unwrap();
        let states: Vec<_> = rec.history.iter().map(|t| t.state).collect();
        assert_eq!(
            states,
            vec![
                RunState::Pending,
                RunState::Claimed,
                RunState::Extracting,
                RunState::Writing,
                RunState::Uploading,
                RunState::Complete
            ]
        );
        assert!(rec
            .history
            .iter()
            .all(|t| chrono::DateTime::parse_from_rfc3339(&t.at).is_ok()));
        assert_eq!(rec.status, "Signals ready.");
        let w = load(d.path(), &job).unwrap();
        assert!(w.status.chars().count() <= MAX_STATUS_CHARS);
        let failed = {
            let j2 = request(
                d.path(),
                RunRequestInput {
                    source_digest: "z".into(),
                    ..input()
                },
            )
            .unwrap()
            .request
            .job_id;
            to_extracting(d.path(), &j2, "s9");
            progress(d.path(), &j2, "s9", RunState::Failed, Some("Bad\noutput")).unwrap()
        };
        assert_eq!(failed.state, RunState::Failed);
        assert_eq!(failed.status, "Badoutput");
    }

    #[test]
    fn other_sessions_cannot_progress_cancel_or_take_a_live_run() {
        let d = tempfile::tempdir().unwrap();
        let job = request(d.path(), input()).unwrap().request.job_id;
        claim(d.path(), &job, &sess(Provider::Claude, "A"), Some(10)).unwrap();
        assert!(claim(d.path(), &job, &sess(Provider::Codex, "B"), Some(11)).is_err());
        assert!(progress(d.path(), &job, "B", RunState::Extracting, None).is_err());
        assert!(cancel(d.path(), &job, Some("B")).is_err());
        assert!(recover(
            d.path(),
            &job,
            &sess(Provider::Codex, "B"),
            Some(11),
            |_| true
        )
        .is_err());
        assert_eq!(
            load(d.path(), &job).unwrap().provider_session_id.as_deref(),
            Some("A")
        );
        // A second concurrent job is independent.
        let j2 = request(
            d.path(),
            RunRequestInput {
                source_ref: "m2".into(),
                ..input()
            },
        )
        .unwrap()
        .request
        .job_id;
        claim(d.path(), &j2, &sess(Provider::Codex, "B"), Some(11)).unwrap();
        cancel(d.path(), &j2, Some("B")).unwrap();
        assert_eq!(load(d.path(), &job).unwrap().state, RunState::Claimed);
        // Dead owner → another session may recover.
        let plan = recover(
            d.path(),
            &job,
            &sess(Provider::Codex, "B"),
            Some(12),
            |_| false,
        )
        .unwrap();
        assert_eq!(plan.record.provider_session_id.as_deref(), Some("B"));
        assert!(plan.needs_model_call);
    }

    #[test]
    fn provider_choice_is_enforced() {
        let d = tempfile::tempdir().unwrap();
        let job = request(
            d.path(),
            RunRequestInput {
                provider: ProviderChoice::Claude,
                ..input()
            },
        )
        .unwrap()
        .request
        .job_id;
        assert!(claim(d.path(), &job, &sess(Provider::Codex, "B"), None).is_err());
        claim(d.path(), &job, &sess(Provider::Claude, "A"), None).unwrap();
    }

    #[test]
    fn resume_after_stored_parse_never_needs_a_second_model_call() {
        let d = tempfile::tempdir().unwrap();
        let job = request(d.path(), input()).unwrap().request.job_id;
        to_extracting(d.path(), &job, "A");
        let parsed = serde_json::json!({"signals": [{"type": "decision", "title": "Ship"}]});
        store_parsed_result(d.path(), &job, "A", &parsed).unwrap();
        // Identical re-store is idempotent; a different parse is refused.
        store_parsed_result(d.path(), &job, "A", &parsed).unwrap();
        assert!(store_parsed_result(d.path(), &job, "A", &serde_json::json!({})).is_err());
        // Interrupted: session A's process died.
        let plan = recover(
            d.path(),
            &job,
            &sess(Provider::Claude, "C"),
            Some(3),
            |_| false,
        )
        .unwrap();
        assert!(!plan.needs_model_call);
        assert_eq!(plan.record.state, RunState::Writing);
        assert_eq!(
            read_parsed_result(d.path(), &job).unwrap(),
            Some(parsed.clone())
        );
        // Cancelled, then the button is pressed again → same job, parse retained.
        cancel(d.path(), &job, None).unwrap();
        let again = request(d.path(), input()).unwrap();
        assert_eq!(again.request.job_id, job);
        assert_eq!(again.state, RunState::Pending);
        let plan = recover(d.path(), &job, &sess(Provider::Codex, "D"), None, |_| true).unwrap();
        assert!(!plan.needs_model_call);
        assert_eq!(plan.record.state, RunState::Writing);
    }

    #[test]
    fn writing_requires_a_stored_parse() {
        let d = tempfile::tempdir().unwrap();
        let job = request(d.path(), input()).unwrap().request.job_id;
        to_extracting(d.path(), &job, "A");
        assert!(progress(d.path(), &job, "A", RunState::Writing, None).is_err());
    }

    #[test]
    fn no_compatible_interactive_session_keeps_run_pending() {
        let d = tempfile::tempdir().unwrap();
        let rec = request(
            d.path(),
            RunRequestInput {
                provider: ProviderChoice::Claude,
                ..input()
            },
        )
        .unwrap();
        let sessions = vec![
            sess(Provider::Codex, "codex-1"),
            ProviderSession {
                provider: Provider::Claude,
                session_id: "headless".into(),
                interactive: false,
            },
        ];
        assert!(compatible_session(&rec, &sessions).is_none());
        assert!(compatible_session(&rec, &[]).is_none());
        let still = dispatch(d.path(), &rec.request.job_id, &sessions).unwrap();
        assert_eq!(still.state, RunState::Pending);
        assert!(claim(d.path(), &rec.request.job_id, &sessions[1], None).is_err());
        let after = load(d.path(), &rec.request.job_id).unwrap();
        assert_eq!(after.state, RunState::Pending);
        assert_eq!(after.status, RunState::Pending.default_status());
        assert!(after.provider_session_id.is_none());
    }

    #[test]
    fn module_has_no_process_spawn_path() {
        let src = include_str!("local_signal_runs.rs");
        let body = src.split("#[cfg(test)]").next().unwrap();
        for needle in [
            "Command::new",
            "std::process::Command",
            "tokio::process",
            "spawn(",
        ] {
            assert!(!body.contains(needle), "unexpected {needle}");
        }
    }

    #[test]
    fn job_ids_cannot_escape_the_runs_dir() {
        let d = tempfile::tempdir().unwrap();
        assert!(load(d.path(), "../../etc/passwd").is_err());
    }
}

#[cfg(test)]
#[path = "local_signal_runs_acceptance.rs"]
mod acceptance;
