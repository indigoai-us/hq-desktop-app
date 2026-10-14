//! signals-local-meetings-v1 US-006 — Tauri commands over the personal
//! meeting observation store (`crate::local_signals`). All file work runs in
//! `spawn_blocking`.
use std::path::PathBuf;

use crate::local_signals::store::{self, CommitOutcome, LocalTranscript, ParsedResult, RunContext};

use super::local_signal_runs::{self as runs, RunRecord as JobRecord, RunRequestInput};

fn hq_root() -> Result<PathBuf, String> {
    Ok(PathBuf::from(super::status::resolve_hq_folder_path()?))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| "Local signal worker failed".to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum EnqueueOutcome {
    /// A complete receipt already covers this source and these versions.
    Skipped,
    Queued {
        record: JobRecord,
    },
}

/// The normal enqueue path: a complete receipt makes it a no-op.
pub fn enqueue(
    hq_root: &std::path::Path,
    runs_dir: &std::path::Path,
    source_id: &str,
    input: RunRequestInput,
) -> Result<EnqueueOutcome, String> {
    if store::is_complete(
        hq_root,
        &input.company_uid,
        source_id,
        &input.source_digest,
        &input.prompt_version,
        &input.schema_version,
    )? {
        return Ok(EnqueueOutcome::Skipped);
    }
    Ok(EnqueueOutcome::Queued {
        record: runs::request(runs_dir, input)?,
    })
}

#[tauri::command]
pub async fn local_signals_enqueue(
    account_id: String,
    source_id: String,
    input: RunRequestInput,
) -> Result<EnqueueOutcome, String> {
    let dir = runs::runs_dir(&account_id)?;
    let root = hq_root()?;
    blocking(move || enqueue(&root, &dir, &source_id, input)).await
}

/// Write the stored parsed result for `context.job_id` to the personal store.
#[tauri::command]
pub async fn local_signals_commit(
    account_id: String,
    context: RunContext,
    transcript: LocalTranscript,
) -> Result<CommitOutcome, String> {
    let dir = runs::runs_dir(&account_id)?;
    let root = hq_root()?;
    blocking(move || {
        let job = runs::load(&dir, &context.job_id)?;
        if job.request.company_uid != context.company_uid
            || job.request.member_uid != context.member_uid
            || job.request.source_ref != context.source_ref
            || job.request.source_digest != context.source_digest
            || job.request.prompt_version != context.prompt_version
            || job.request.schema_version != context.schema_version
        {
            return Err("Run context does not match the signal run".into());
        }
        let value = runs::read_parsed_result(&dir, &context.job_id)?
            .ok_or("No parsed result stored for this run")?;
        let parsed: ParsedResult = serde_json::from_value(value)
            .map_err(|_| "Parsed result does not match the v1 schema")?;
        store::commit(&root, context, parsed, &transcript)
    })
    .await
}

/// Finish a stored run (e.g. after a citation failure) without a model call.
#[tauri::command]
pub async fn local_signals_resume(
    company_uid: String,
    job_id: String,
    transcript: LocalTranscript,
) -> Result<CommitOutcome, String> {
    let root = hq_root()?;
    blocking(move || store::resume(&root, &company_uid, &job_id, &transcript)).await
}

// ── US-007: interactive extractor ────────────────────────────────────────────

use crate::local_signals::extractor::{
    self, ExtractOutcome, PromptInput, ProviderFailure, Recovery, SessionPlan,
};
use crate::local_signals::ontology_tools::{Projection, ToolHost};
use crate::local_signals::store::valid_segment;

fn projection_for(
    root: &std::path::Path,
    company_slug: &str,
    ctx: &RunContext,
) -> Result<Projection, String> {
    if !valid_segment(company_slug) || !valid_segment(&ctx.member_uid) {
        return Err("Invalid company or member".into());
    }
    let dir = root
        .join("companies")
        .join(company_slug)
        .join("ontology/projections/members")
        .join(&ctx.member_uid)
        .join("v1");
    Ok(Projection::load(&dir, &ctx.company_uid, &ctx.member_uid))
}

fn host_for(
    root: &std::path::Path,
    company_slug: &str,
    ctx: &RunContext,
) -> Result<(ToolHost, std::path::PathBuf), String> {
    let projection = projection_for(root, company_slug, ctx)?;
    let mut host = ToolHost::new(
        root,
        &ctx.company_uid,
        &ctx.job_id,
        &ctx.source_ref,
        projection,
        chrono::Utc::now().timestamp_millis(),
    )?;
    let ledger = ToolHost::ledger_path(root, &ctx.company_uid, &ctx.job_id)?;
    host.load_ledger(&ledger)?;
    Ok((host, ledger))
}

/// Write the prompt and open a fresh, visible Claude Code or Codex session.
#[tauri::command]
pub async fn local_signals_launch_session(
    company_slug: String,
    provider: runs::Provider,
    context: RunContext,
    transcript_markdown: String,
) -> Result<SessionPlan, String> {
    let root = hq_root()?;
    blocking(move || {
        context.validate()?;
        let (host, _) = host_for(&root, &company_slug, &context)?;
        let prompt = extractor::build_prompt(&PromptInput {
            ctx: &context,
            transcript_markdown: &transcript_markdown,
            projection: &host.status(),
        });
        let path = extractor::prompt_path(&root, &context.company_uid, &context.job_id)?;
        crate::local_signals::store::write_atomic(&path, prompt.as_bytes())?;
        let kickoff = extractor::kickoff_prompt(&context.job_id, &path);
        let plan = extractor::plan_session(provider, &root, &kickoff)?;
        extractor::launch_session(&plan, &kickoff)?;
        Ok(plan)
    })
    .await
}

/// The bridge for model tool calls. Only the four registered tools run.
#[tauri::command]
pub async fn local_signals_tool_call(
    company_slug: String,
    context: RunContext,
    tool: String,
    input: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let root = hq_root()?;
    blocking(move || {
        context.validate()?;
        let (mut host, ledger) = host_for(&root, &company_slug, &context)?;
        let out = host.call(&tool, &input).map_err(|e| e.to_string())?;
        host.save_ledger(&ledger)?;
        Ok(out)
    })
    .await
}

/// Validate the stored session output and write it to the personal store.
#[tauri::command]
pub async fn local_signals_extract(
    account_id: String,
    company_slug: String,
    context: RunContext,
    transcript: LocalTranscript,
) -> Result<ExtractOutcome, String> {
    let dir = runs::runs_dir(&account_id)?;
    let root = hq_root()?;
    blocking(move || {
        context.validate()?;
        let output = runs::read_parsed_result(&dir, &context.job_id)?
            .ok_or("No session output stored for this run")?;
        let (host, _) = host_for(&root, &company_slug, &context)?;
        extractor::extract_and_store(&root, context, &output, &transcript, &host)
    })
    .await
}

/// Provider logout or transport loss: keep the run recoverable and return the
/// single plain-language recovery action for Meetings.
#[tauri::command]
pub async fn local_signals_provider_failure(
    account_id: String,
    job_id: String,
    session_id: String,
    provider: runs::Provider,
    failure: ProviderFailure,
) -> Result<Recovery, String> {
    let dir = runs::runs_dir(&account_id)?;
    blocking(move || {
        extractor::handle_provider_failure(&dir, &job_id, &session_id, provider, failure)
            .map(|(_, r)| r)
    })
    .await
}
