//! signals-local-meetings-v1 US-007 — the eight-type interactive meeting extractor.
//!
//! The model runs only inside a fresh, visible Claude Code or Codex session the
//! member can see ([`plan_session`]). It decides when to call the four tools in
//! [`super::ontology_tools`]; this module builds the prompt, validates what the
//! session returns, records exact guard failures in diagnostics, and hands a
//! valid result to the personal store. There is no print/exec mode, no cloud
//! inference fallback, and no path that accepts the cloud extractor's output.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use super::ontology_tools::{ProjectionStatus, ToolHost, TOOL_NAMES};
use super::store::{
    self, company_root, run_record_path, write_atomic, Citation, CommitOutcome, EntityRef,
    EntityStatus, LocalTranscript, ParsedObservation, ParsedResult, RunContext, SignalType,
};
use crate::commands::local_signal_runs::{self as runs, Provider, RunRecord as JobRecord};

pub const PROMPT_VERSION: &str = "local-signals-prompt/v1";
pub const SCHEMA_VERSION: &str = "local-signal/v1";
pub const OUTPUT_SCHEMA: &str = "hq-local-meeting-extraction/v1";

// ── session contract ─────────────────────────────────────────────────────────

/// How a run reaches a model: always a visible, interactive session.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SessionPlan {
    /// A new Terminal window running interactive `claude` with a kickoff prompt.
    ClaudeTerminal { workspace: String, command: String },
    /// `codex app <workspace>` then a new-thread deep link with the kickoff prompt.
    CodexApp {
        workspace: String,
        thread_url: String,
    },
}

/// Flags and subcommands that would run a model headless. Never allowed.
pub const FORBIDDEN_INVOCATIONS: [&str; 6] = [
    "-p",
    "--print",
    "exec",
    "--output-format",
    "--headless",
    "cloud",
];

pub fn kickoff_prompt(job_id: &str, prompt_path: &Path) -> String {
    format!(
        "HQ local meeting signals, job {job_id}. Read {} and follow it. Use only the ontology.list, ontology.inspect, ontology.search_alias, and queue_entity_candidate tools.",
        prompt_path.display()
    )
}

pub fn plan_session(
    provider: Provider,
    workspace: &Path,
    kickoff: &str,
) -> Result<SessionPlan, String> {
    let workspace = workspace.display().to_string();
    let plan = match provider {
        Provider::Claude => SessionPlan::ClaudeTerminal {
            command: crate::commands::launch::claude_command(None, Some(kickoff))?,
            workspace,
        },
        Provider::Codex => SessionPlan::CodexApp {
            thread_url: crate::commands::launch::codex_thread_url(kickoff),
            workspace,
        },
    };
    assert_interactive(&plan)?;
    Ok(plan)
}

/// Refuse any plan whose program arguments would run a model non-interactively.
pub fn assert_interactive(plan: &SessionPlan) -> Result<(), String> {
    let argv: Vec<String> = match plan {
        SessionPlan::ClaudeTerminal { command, .. } => {
            // Only the program and its flags; the quoted kickoff prompt is data.
            let program = command.split(" '").next().unwrap_or(command);
            if !(program == "claude" || program.starts_with("claude ")) {
                return Err("Claude sessions must run the interactive claude program".into());
            }
            program.split_whitespace().map(String::from).collect()
        }
        SessionPlan::CodexApp { thread_url, .. } => {
            if !thread_url.starts_with("codex://threads/new?prompt=") {
                return Err("Codex sessions must open a visible thread".into());
            }
            vec!["codex".into(), "app".into()]
        }
    };
    if argv
        .iter()
        .any(|a| FORBIDDEN_INVOCATIONS.contains(&a.as_str()))
    {
        return Err("Headless model invocation is not allowed".into());
    }
    Ok(())
}

/// Open the planned session through the existing visible launchers only.
pub fn launch_session(plan: &SessionPlan, kickoff: &str) -> Result<(), String> {
    assert_interactive(plan)?;
    match plan {
        SessionPlan::ClaudeTerminal { workspace, .. } => {
            crate::commands::launch::launch_claude_code(
                workspace.clone(),
                None,
                Some(kickoff.to_string()),
            )
        }
        SessionPlan::CodexApp { workspace, .. } => crate::commands::launch::launch_codex_workspace(
            workspace.clone(),
            Some(kickoff.to_string()),
        ),
    }
}

// ── prompt ───────────────────────────────────────────────────────────────────

pub struct PromptInput<'a> {
    pub ctx: &'a RunContext,
    pub transcript_markdown: &'a str,
    pub projection: &'a ProjectionStatus,
}

/// The extraction prompt. The transcript is the only source material given.
pub fn build_prompt(p: &PromptInput) -> String {
    let c = p.ctx;
    let types = SignalType::ALL
        .iter()
        .map(|t| t.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"# HQ local meeting signals ({PROMPT_VERSION})

Extract cited signals from the meeting transcript below. Signal types: {types}.

Rules:
- summary: one short overview of the meeting.
- key_point: an important point raised.
- decision: what was decided; set "reasoning" to why.
- action_item: a task; set "owner" to who owns it.
- participant_contribution: what one person contributed; set "speaker".
- risk, commitment, question: as stated in the meeting.
- Every observation cites at least one transcript time range in milliseconds
  (startMs <= endMs <= the last transcript timestamp).
- Resolve people, companies, projects, and products only with the tools:
  {tools}. Put an entity id in "entityRefs" only if a tool returned it in this
  session. For a name the tools do not resolve, call queue_entity_candidate and
  put the returned candidateId in "candidateRefs". Never invent an entity id and
  never read or write files under ontology/.
- Projection state is "{state}" (watermark {watermark}). When it is not ready,
  the lookups return nothing: queue candidates instead.
- Do not quote long transcript passages in "content".

Return exactly one JSON object:
{{"schema":"{OUTPUT_SCHEMA}","extractor":{{"provider":"claude|codex","mode":"interactive"}},
"memberUid":"{member}","sourceRef":"{source_ref}","sourceDigest":"{digest}",
"audienceKey":"{aud_key}","audienceReceiptRef":"{aud_ref}","schemaVersion":"{SCHEMA_VERSION}",
"observations":[{{"type":"decision","content":"...","citations":[{{"startMs":0,"endMs":1000}}],
"entityRefs":[],"candidateRefs":[],"owner":null,"reasoning":"...","speaker":null}}]}}

## Transcript ({source_ref})

{transcript}
"#,
        tools = TOOL_NAMES.join(", "),
        state = p.projection.state.as_str(),
        watermark = p.projection.watermark.as_deref().unwrap_or("none"),
        member = c.member_uid,
        source_ref = c.source_ref,
        digest = c.source_digest,
        aud_key = c.audience_key,
        aud_ref = c.audience_receipt_ref,
        transcript = p.transcript_markdown,
    )
}

/// Where the prompt for a job is written for the session to read.
pub fn prompt_path(hq_root: &Path, company_uid: &str, job_id: &str) -> Result<PathBuf, String> {
    Ok(run_record_path(&company_root(hq_root, company_uid)?, job_id)?.with_extension("prompt.md"))
}

// ── output validation ────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GuardFailure {
    pub code: String,
    #[serde(default)]
    pub observation: Option<usize>,
    pub detail: String,
}

fn fail(code: &str, observation: Option<usize>, detail: impl Into<String>) -> GuardFailure {
    GuardFailure {
        code: code.into(),
        observation,
        detail: detail.into(),
    }
}

/// Validate the session's JSON against the eight-type schema, citation bounds,
/// member identity, source digest, audience receipt, and same-run lookups.
pub fn validate_output(
    output: &Value,
    ctx: &RunContext,
    transcript: &LocalTranscript,
    host: &ToolHost,
) -> Result<ParsedResult, Vec<GuardFailure>> {
    let mut f = Vec::new();
    let s = |k: &str| output.get(k).and_then(Value::as_str);
    if s("schema") != Some(OUTPUT_SCHEMA) || s("schemaVersion") != Some(ctx.schema_version.as_str())
    {
        f.push(fail(
            "schema_mismatch",
            None,
            "output schema or schema version is not the run's",
        ));
    }
    let provider = output
        .pointer("/extractor/provider")
        .and_then(Value::as_str);
    let mode = output.pointer("/extractor/mode").and_then(Value::as_str);
    if !matches!(provider, Some("claude" | "codex"))
        || mode != Some("interactive")
        || provider != Some(ctx.extractor_provider.as_str())
    {
        f.push(fail(
            "non_interactive_extractor",
            None,
            "output did not come from this run's interactive Claude or Codex session",
        ));
    }
    if s("memberUid") != Some(ctx.member_uid.as_str()) {
        f.push(fail(
            "member_mismatch",
            None,
            "memberUid is not the run's member",
        ));
    }
    if s("sourceRef") != Some(ctx.source_ref.as_str()) {
        f.push(fail(
            "source_mismatch",
            None,
            "sourceRef is not the run's source",
        ));
    }
    if s("sourceDigest") != Some(ctx.source_digest.as_str())
        || transcript.source_digest != ctx.source_digest
    {
        f.push(fail(
            "digest_mismatch",
            None,
            "source digest does not match the run and local transcript",
        ));
    }
    if s("audienceKey") != Some(ctx.audience_key.as_str())
        || s("audienceReceiptRef") != Some(ctx.audience_receipt_ref.as_str())
    {
        f.push(fail(
            "audience_mismatch",
            None,
            "audience key or receipt does not match the run",
        ));
    }
    let Some(items) = output.get("observations").and_then(Value::as_array) else {
        f.push(fail(
            "schema_mismatch",
            None,
            "observations must be an array",
        ));
        return Err(f);
    };
    if items.is_empty() || items.len() > store::MAX_OBSERVATIONS {
        f.push(fail(
            "schema_mismatch",
            None,
            "observations must contain 1-256 items",
        ));
    }
    let mut out = Vec::new();
    for (i, o) in items.iter().enumerate() {
        let ty = o.get("type").and_then(Value::as_str).unwrap_or("");
        let Some(signal_type) = SignalType::ALL.iter().copied().find(|t| t.as_str() == ty) else {
            f.push(fail(
                "invalid_type",
                Some(i),
                format!(
                    "unknown signal type {:?}",
                    ty.chars().take(40).collect::<String>()
                ),
            ));
            continue;
        };
        let content = o
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if content.is_empty() || content.chars().count() > store::MAX_CONTENT_CHARS {
            f.push(fail(
                "invalid_content",
                Some(i),
                "content is empty or too long",
            ));
        }
        let mut citations = Vec::new();
        let raw = o
            .get("citations")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if raw.is_empty() || raw.len() > store::MAX_CITATIONS {
            f.push(fail(
                "citation_out_of_bounds",
                Some(i),
                "needs 1-32 citations",
            ));
        }
        for c in &raw {
            let (Some(a), Some(b)) = (
                c.get("startMs").and_then(Value::as_u64),
                c.get("endMs").and_then(Value::as_u64),
            ) else {
                f.push(fail(
                    "citation_out_of_bounds",
                    Some(i),
                    "citation needs integer startMs and endMs",
                ));
                continue;
            };
            if a > b || b > transcript.duration_ms {
                f.push(fail(
                    "citation_out_of_bounds",
                    Some(i),
                    format!("{a}-{b} ms is outside the transcript"),
                ));
            }
            citations.push(Citation {
                source_ref: ctx.source_ref.clone(),
                start_ms: a,
                end_ms: b,
            });
        }
        let detail = |k: &str| {
            o.get(k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(String::from)
        };
        let (owner, reasoning, speaker) = (detail("owner"), detail("reasoning"), detail("speaker"));
        match signal_type {
            SignalType::ActionItem if owner.is_none() => {
                f.push(fail("missing_owner", Some(i), "action_item needs an owner"))
            }
            SignalType::Decision if reasoning.is_none() => f.push(fail(
                "missing_reasoning",
                Some(i),
                "decision needs reasoning",
            )),
            SignalType::ParticipantContribution if speaker.is_none() => f.push(fail(
                "missing_speaker",
                Some(i),
                "participant_contribution needs a speaker",
            )),
            _ => {}
        }
        let mut entities = Vec::new();
        for r in o
            .get("entityRefs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let id = r.as_str().unwrap_or("");
            match host.seen_entity(id) {
                Some(name) => entities.push(EntityRef {
                    entity_id: Some(id.into()),
                    name,
                    status: EntityStatus::Resolved,
                }),
                None => f.push(fail(
                    "entity_ref_not_looked_up",
                    Some(i),
                    format!(
                        "entity {:?} was not returned by a lookup in this run",
                        id.chars().take(80).collect::<String>()
                    ),
                )),
            }
        }
        for r in o
            .get("candidateRefs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let id = r.as_str().unwrap_or("");
            match host.ledger.candidates.get(id) {
                Some(c) => entities.push(EntityRef {
                    entity_id: None,
                    name: c.name.clone(),
                    status: EntityStatus::Provisional,
                }),
                None => f.push(fail(
                    "unknown_candidate",
                    Some(i),
                    "candidateRef was not queued in this run",
                )),
            }
        }
        if entities.len() > store::MAX_ENTITIES {
            f.push(fail("schema_mismatch", Some(i), "too many entities"));
        }
        out.push(ParsedObservation {
            signal_type,
            content,
            citations,
            entities,
            owner,
            reasoning,
            speaker,
        });
    }
    if f.is_empty() {
        Ok(ParsedResult { observations: out })
    } else {
        Err(f)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub job_id: String,
    pub at: String,
    pub failures: Vec<GuardFailure>,
}

pub fn diagnostics_path(
    hq_root: &Path,
    company_uid: &str,
    job_id: &str,
) -> Result<PathBuf, String> {
    Ok(
        run_record_path(&company_root(hq_root, company_uid)?, job_id)?
            .with_extension("diagnostics.json"),
    )
}

pub fn read_diagnostics(
    hq_root: &Path,
    company_uid: &str,
    job_id: &str,
) -> Result<Option<Diagnostics>, String> {
    match std::fs::read(diagnostics_path(hq_root, company_uid, job_id)?) {
        Ok(b) => serde_json::from_slice(&b)
            .map(Some)
            .map_err(|_| "Corrupt diagnostics".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Cannot read diagnostics".into()),
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum ExtractOutcome {
    /// Guard failures; nothing reached the local store.
    Rejected { failures: Vec<GuardFailure> },
    Stored {
        commit: CommitOutcome,
        projection: ProjectionStatus,
    },
}

/// Validate the session output and, only if it passes, commit it locally. The
/// run context records the projection state and watermark the tools saw.
pub fn extract_and_store(
    hq_root: &Path,
    mut ctx: RunContext,
    output: &Value,
    transcript: &LocalTranscript,
    host: &ToolHost,
) -> Result<ExtractOutcome, String> {
    let status = host.status();
    ctx.projection_state = status.state.as_str().into();
    ctx.projection_watermark = status.watermark.clone().unwrap_or_else(|| "none".into());
    match validate_output(output, &ctx, transcript, host) {
        Err(failures) => {
            let d = Diagnostics {
                job_id: ctx.job_id.clone(),
                at: chrono::Utc::now().to_rfc3339(),
                failures: failures.clone(),
            };
            let bytes = serde_json::to_vec_pretty(&d).map_err(|_| "Cannot encode diagnostics")?;
            write_atomic(
                &diagnostics_path(hq_root, &ctx.company_uid, &ctx.job_id)?,
                &bytes,
            )?;
            Ok(ExtractOutcome::Rejected { failures })
        }
        Ok(parsed) => Ok(ExtractOutcome::Stored {
            commit: store::commit(hq_root, ctx, parsed, transcript)?,
            projection: status,
        }),
    }
}

// ── provider loss ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderFailure {
    LoggedOut,
    TransportLost,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    SignInAgain,
    Resume,
}

/// One named action and plain text for Meetings. Never carries a raw error.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub action: RecoveryAction,
    pub label: String,
    pub message: String,
}

pub fn recovery_for(provider: Provider, failure: ProviderFailure) -> Recovery {
    let name = match provider {
        Provider::Claude => "Claude",
        Provider::Codex => "Codex",
    };
    match failure {
        ProviderFailure::LoggedOut => Recovery {
            action: RecoveryAction::SignInAgain,
            label: format!("Sign in to {name}"),
            message: format!("{name} signed out. Sign in again to continue."),
        },
        ProviderFailure::TransportLost => Recovery {
            action: RecoveryAction::Resume,
            label: "Resume".into(),
            message: format!("The connection to {name} dropped. Your progress is saved."),
        },
    }
}

/// Release the run so it stays pending (or resumable after a stored parse)
/// and return the single recovery action to show. The raw transport error is
/// dropped here and never reaches the run status.
pub fn handle_provider_failure(
    runs_dir: &Path,
    job_id: &str,
    session_id: &str,
    provider: Provider,
    failure: ProviderFailure,
) -> Result<(JobRecord, Recovery), String> {
    let r = recovery_for(provider, failure);
    let action = match r.action {
        RecoveryAction::SignInAgain => "sign_in_again",
        RecoveryAction::Resume => "resume",
    };
    let rec = runs::release_for_provider_loss(runs_dir, job_id, session_id, &r.message, action)?;
    Ok((rec, r))
}
