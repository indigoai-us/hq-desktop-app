//! signals-local-meetings-v1 US-009 — Generate signals on the existing
//! Meetings surface.
//!
//! Five commands back the inline Meetings row: status, generate, open a
//! provider session, cancel, and upload. Each resolves the account, the HQ
//! root, and the company-scoped kill switch itself. Errors returned to the UI
//! are short plain codes; raw HTTP, JSON, and transport text goes only to the
//! diagnostics log (`~/.hq/logs`, component `local-signals`).
use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::local_signals::eligibility::{self, IneligibleReason, MeetingEligibility};
use crate::local_signals::extractor::{PROMPT_VERSION, SCHEMA_VERSION};
use crate::local_signals::receipt;
use crate::local_signals::store::{self, RunContext};
use crate::local_signals::upload::{self, UploadSummary};

use super::local_signal_runs::{
    self as runs, Provider, ProviderChoice, RunRecord, RunRequestInput, RunState,
};

pub const SIGNALS_FLAG: &str = "desktop.signals-local-meetings-v1";

fn diag(msg: &str) {
    crate::util::logfile::log("local-signals", msg);
}

fn hq_root() -> Result<PathBuf, String> {
    Ok(PathBuf::from(
        super::status::resolve_hq_folder_path().map_err(|e| {
            diag(&format!("hq root: {e}"));
            "hq_root_unavailable".to_string()
        })?,
    ))
}

async fn runs_dir() -> Result<PathBuf, String> {
    let tokens = super::cognito::get_tokens()
        .await
        .map_err(|_| "signed_out".to_string())?
        .ok_or_else(|| "signed_out".to_string())?;
    runs::runs_dir(&super::auth::notification_identity_from_tokens(&tokens))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| "worker_failed".to_string())?
}

/// Kill-switch semantics for `desktop.signals-local-meetings-v1`, per
/// `indigo-feature-flags-default-on-as-fail-safes` and US-008 AC8: the feature
/// stays ON when the flag row is absent, archived, or unreadable; only an
/// explicit `false` turns it off. (This supersedes the older US-009 AC7
/// wording that hid the action for a missing or unreadable flag.)
pub fn flag_on_from(read: Result<Option<bool>, ()>) -> bool {
    !matches!(read, Ok(Some(false)))
}

async fn flag_on(company_uid: &str) -> bool {
    flag_on_from(super::hq_pro::feature_flag_read_for_company(SIGNALS_FLAG, company_uid).await)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSignalsStatus {
    /// False only when the flag is explicitly off. Nothing else is shown.
    pub enabled: bool,
    pub eligible: bool,
    pub ineligible_reason: Option<IneligibleReason>,
    pub run: Option<RunRecord>,
    /// A complete local receipt exists for this source and these versions.
    pub local_complete: bool,
    pub upload: Option<UploadSummary>,
}

impl MeetingSignalsStatus {
    fn hidden() -> Self {
        MeetingSignalsStatus {
            enabled: false,
            eligible: false,
            ineligible_reason: None,
            run: None,
            local_complete: false,
            upload: None,
        }
    }
}

/// Latest run for this member, source, and digest.
pub fn latest_run(
    dir: &Path,
    company_uid: &str,
    member_uid: &str,
    e: &MeetingEligibility,
) -> Result<Option<RunRecord>, String> {
    let digest = e.source_digest.as_deref().unwrap_or("");
    let mut matches: Vec<RunRecord> = runs::list(dir)?
        .into_iter()
        .filter(|r| {
            r.request.company_uid == company_uid
                && r.request.member_uid == member_uid
                && r.request.source_ref == e.source_ref
                && r.request.source_digest == digest
        })
        .collect();
    matches.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
    Ok(matches.pop())
}

pub fn local_receipt(
    hq: &Path,
    company_uid: &str,
    bot_id: &str,
    e: &MeetingEligibility,
) -> Result<Option<receipt::Receipt>, String> {
    let Some(digest) = e.source_digest.as_deref() else {
        return Ok(None);
    };
    let root = store::company_root(hq, company_uid)?;
    receipt::read(&receipt::receipt_path(
        &root,
        bot_id,
        digest,
        PROMPT_VERSION,
        SCHEMA_VERSION,
    )?)
}

/// Pure status assembly, shared by the command and the tests.
pub fn status_for(
    hq: &Path,
    dir: &Path,
    enabled: bool,
    company_uid: &str,
    member_uid: &str,
    bot_id: &str,
) -> Result<MeetingSignalsStatus, String> {
    if !enabled {
        return Ok(MeetingSignalsStatus::hidden());
    }
    let e = eligibility::evaluate(hq, company_uid, member_uid, bot_id);
    if !e.eligible {
        return Ok(MeetingSignalsStatus {
            enabled: true,
            eligible: false,
            ineligible_reason: e.reason,
            ..MeetingSignalsStatus::hidden()
        });
    }
    let run = latest_run(dir, company_uid, member_uid, &e)?;
    let local = local_receipt(hq, company_uid, bot_id, &e)?;
    let local_complete = local
        .as_ref()
        .is_some_and(|r| r.status == receipt::ReceiptStatus::Complete);
    let upload = match (&local, local_complete) {
        (Some(r), true) => Some(upload::summarize(
            &store::company_root(hq, company_uid)?,
            r,
        )?),
        _ => None,
    };
    Ok(MeetingSignalsStatus {
        enabled: true,
        eligible: true,
        ineligible_reason: None,
        run,
        local_complete,
        upload,
    })
}

#[tauri::command]
pub async fn meeting_signals_status(
    company_uid: String,
    bot_id: String,
    member_uid: String,
) -> Result<MeetingSignalsStatus, String> {
    if !flag_on(&company_uid).await {
        return Ok(MeetingSignalsStatus::hidden());
    }
    let hq = hq_root()?;
    let dir = runs_dir().await?;
    blocking(move || status_for(&hq, &dir, true, &company_uid, &member_uid, &bot_id)).await
}

/// Queue (or reuse) the durable run. A complete local receipt is a no-op.
pub fn generate_in(
    hq: &Path,
    dir: &Path,
    company_uid: &str,
    member_uid: &str,
    bot_id: &str,
    provider: ProviderChoice,
) -> Result<MeetingSignalsStatus, String> {
    let e = eligibility::evaluate(hq, company_uid, member_uid, bot_id);
    if !e.eligible {
        return Err("not_eligible".into());
    }
    let input = RunRequestInput {
        company_uid: company_uid.into(),
        member_uid: member_uid.into(),
        source_ref: e.source_ref.clone(),
        source_digest: e.source_digest.clone().unwrap_or_default(),
        audience_receipt_ref: e.audience_receipt_ref.clone().unwrap_or_default(),
        provider,
        prompt_version: PROMPT_VERSION.into(),
        schema_version: SCHEMA_VERSION.into(),
    };
    super::local_signals::enqueue(hq, dir, bot_id, input)?;
    status_for(hq, dir, true, company_uid, member_uid, bot_id)
}

#[tauri::command]
pub async fn meeting_signals_generate(
    company_uid: String,
    bot_id: String,
    member_uid: String,
    provider: Option<ProviderChoice>,
) -> Result<MeetingSignalsStatus, String> {
    if !flag_on(&company_uid).await {
        return Ok(MeetingSignalsStatus::hidden());
    }
    let hq = hq_root()?;
    let dir = runs_dir().await?;
    blocking(move || {
        generate_in(
            &hq,
            &dir,
            &company_uid,
            &member_uid,
            &bot_id,
            provider.unwrap_or(ProviderChoice::Any),
        )
    })
    .await
}

/// Run context for a session. Projection fields are filled at extraction time.
pub fn context_for(
    run: &RunRecord,
    e: &MeetingEligibility,
    provider: Provider,
    device_id: &str,
) -> RunContext {
    RunContext {
        job_id: run.request.job_id.clone(),
        company_uid: run.request.company_uid.clone(),
        member_uid: run.request.member_uid.clone(),
        device_id: if device_id.trim().is_empty() {
            "unknown-device".into()
        } else {
            device_id.chars().take(128).collect()
        },
        source_id: e
            .source_ref
            .trim_start_matches("sources/meetings/")
            .trim_end_matches(".md")
            .to_string(),
        source_ref: e.source_ref.clone(),
        source_digest: run.request.source_digest.clone(),
        audience_key: e.audience_key.clone().unwrap_or_default(),
        audience_version: e.audience_version.unwrap_or(0),
        audience_receipt_ref: run.request.audience_receipt_ref.clone(),
        extractor_provider: match provider {
            Provider::Claude => "claude".into(),
            Provider::Codex => "codex".into(),
        },
        extractor_model: "interactive-session".into(),
        prompt_version: PROMPT_VERSION.into(),
        schema_version: SCHEMA_VERSION.into(),
        projection_watermark: "pending".into(),
        projection_state: "pending".into(),
        ontology_version: "ontology/v1".into(),
        classification: "company-eligible".into(),
        extracted_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// Open a fresh, visible Claude Code or Codex session for the pending run.
/// This is the only recovery path when no session is available; there is no
/// cloud or headless fallback.
#[tauri::command]
pub async fn meeting_signals_open_session(
    company_uid: String,
    bot_id: String,
    member_uid: String,
    provider: Provider,
) -> Result<(), String> {
    if !flag_on(&company_uid).await {
        return Err("disabled".into());
    }
    let hq = hq_root()?;
    let dir = runs_dir().await?;
    let runs_for_launch = dir.clone();
    let bot_for_launch = bot_id.clone();
    let (slug, ctx, body) = blocking(move || {
        let e = eligibility::evaluate(&hq, &company_uid, &member_uid, &bot_id);
        if !e.eligible {
            return Err("not_eligible".to_string());
        }
        let run = latest_run(&dir, &company_uid, &member_uid, &e)?.ok_or("no_run")?;
        if run.state.is_terminal_for_ui() {
            return Err("run_finished".into());
        }
        let device = super::telemetry::read_machine_id();
        Ok((
            e.company_slug.clone().unwrap_or_default(),
            context_for(&run, &e, provider, &device),
            e.transcript_body,
        ))
    })
    .await?;
    super::local_signals::launch_session_in(
        runs_for_launch,
        slug,
        bot_for_launch,
        provider,
        ctx,
        body,
    )
        .await
        .map(|_| ())
        .map_err(|e| {
            diag(&format!("open session failed: {e}"));
            "session_launch_failed".to_string()
        })
}

/// Cancel only this job. Other meetings' jobs and sessions are untouched.
#[tauri::command]
pub async fn meeting_signals_cancel(job_id: String) -> Result<RunRecord, String> {
    let dir = runs_dir().await?;
    blocking(move || runs::cancel(&dir, &job_id, None)).await
}

/// Upload every unsettled observation of a complete local run.
#[tauri::command]
pub async fn meeting_signals_upload(
    company_uid: String,
    bot_id: String,
    member_uid: String,
) -> Result<UploadSummary, String> {
    if !flag_on(&company_uid).await {
        return Err("disabled".into());
    }
    let hq = hq_root()?;
    let (slug, root, rec) = {
        let (hq, cu, bi, mu) = (
            hq.clone(),
            company_uid.clone(),
            bot_id.clone(),
            member_uid.clone(),
        );
        blocking(move || {
            let e = eligibility::evaluate(&hq, &cu, &mu, &bi);
            if !e.eligible {
                return Err("not_eligible".to_string());
            }
            let rec = local_receipt(&hq, &cu, &bi, &e)?.ok_or("not_complete")?;
            Ok((
                e.company_slug.unwrap_or_default(),
                store::company_root(&hq, &cu)?,
                rec,
            ))
        })
        .await?
    };
    if !store::valid_segment(&slug) {
        return Err("not_eligible".into());
    }
    let base = super::meetings::vault_base().await.map_err(|e| {
        diag(&format!("vault base: {e}"));
        "offline".to_string()
    })?;
    let url = format!("{base}/v1/files/contributions/company/{slug}/meetings");
    upload::upload_pending(&root, &rec, |body| {
        let url = url.clone();
        async move {
            let auth = super::meetings::auth_header().await.map_err(|e| {
                diag(&format!("upload auth: {e}"));
                "auth".to_string()
            })?;
            let resp = crate::util::client_info::build_client()
                .post(url)
                .header("authorization", auth)
                .header("content-type", "application/json")
                .timeout(std::time::Duration::from_secs(35))
                .json(&body)
                .send()
                .await
                .map_err(|e| {
                    diag(&format!("upload transport: {e}"));
                    "transport".to_string()
                })?;
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            if !(200..300).contains(&status) {
                diag(&format!(
                    "upload {status}: {}",
                    text.chars().take(800).collect::<String>()
                ));
            }
            Ok((
                status,
                serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
            ))
        }
    })
    .await
}

/// US-010: cited local results for one meeting, read from the personal store.
#[tauri::command]
pub async fn meeting_signals_results(
    company_uid: String,
    bot_id: String,
    member_uid: String,
) -> Result<crate::local_signals::results::MeetingResults, String> {
    if !flag_on(&company_uid).await {
        return Err("disabled".into());
    }
    let hq = hq_root()?;
    blocking(move || {
        let e = eligibility::evaluate(&hq, &company_uid, &member_uid, &bot_id);
        if !e.eligible {
            return Err("not_eligible".to_string());
        }
        crate::local_signals::results::results_for(&hq, &company_uid, &bot_id, &e)
    })
    .await
}

/// US-010: transcript lines for one citation of a current observation. The UI
/// sends only ids; the transcript path comes from the eligibility gate.
#[tauri::command]
pub async fn meeting_signals_citation(
    company_uid: String,
    bot_id: String,
    member_uid: String,
    observation_id: String,
    index: usize,
) -> Result<Vec<String>, String> {
    if !flag_on(&company_uid).await {
        return Err("disabled".into());
    }
    let hq = hq_root()?;
    blocking(move || {
        let e = eligibility::evaluate(&hq, &company_uid, &member_uid, &bot_id);
        if !e.eligible {
            return Err("not_eligible".to_string());
        }
        crate::local_signals::results::open_citation(
            &hq,
            &company_uid,
            &bot_id,
            &e,
            &observation_id,
            index,
        )
    })
    .await
}

trait UiTerminal {
    fn is_terminal_for_ui(self) -> bool;
}
impl UiTerminal for RunState {
    fn is_terminal_for_ui(self) -> bool {
        matches!(self, RunState::Complete | RunState::Cancelled)
    }
}
