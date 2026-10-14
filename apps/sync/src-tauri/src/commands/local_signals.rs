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
