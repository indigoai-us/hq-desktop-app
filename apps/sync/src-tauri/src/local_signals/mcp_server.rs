//! signals-local-meetings-v1 US-007 — the transport between a visible Claude
//! Code session and the local extractor.
//!
//! The desktop binary started as `<exe> --local-signals-mcp <job.json>` is a
//! stdio MCP server for exactly one durable run. It is dispatched at the top
//! of `main()`, before Sentry, single-instance, or Tauri start. It exposes:
//!
//! - `get_meeting_prompt`: the extraction prompt (instructions + transcript),
//! - `ontology_list`, `ontology_inspect`, `ontology_search_alias`,
//!   `queue_entity_candidate`: the four registered ToolHost tools,
//! - `submit_signals`: validates the session's JSON, stores the parsed result,
//!   and writes it to the personal store.
//!
//! `initialize` claims (or recovers) the run for this interactive session.
//! When stdin closes before a result is stored and committed, the run is
//! released as a transport loss so Meetings shows one Resume action.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use super::extractor::{
    self, ExtractOutcome, GuardFailure, ProviderFailure, MCP_ONTOLOGY_TOOLS, MCP_PROMPT_TOOL,
    MCP_SERVER_NAME, MCP_SUBMIT_TOOL,
};
use super::ontology_tools::ToolHost;
use super::store::{valid_segment, CommitOutcome, LocalTranscript, RunContext};
use crate::commands::local_signal_runs::{self as runs, Provider, ProviderSession, RunState};

pub const MCP_ARG: &str = "--local-signals-mcp";
pub const JOB_SCHEMA: &str = "hq-local-signals-mcp-job/v1";
const MAX_JOB_BYTES: u64 = 64 * 1024;
const MAX_PROMPT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const PROTOCOL_FALLBACK: &str = "2025-06-18";

/// Written by the app at launch next to the run record; read once here.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobConfig {
    pub schema: String,
    pub hq_root: PathBuf,
    pub company_slug: String,
    pub bot_id: String,
    pub runs_dir: PathBuf,
    pub provider: Provider,
    pub context: RunContext,
}

fn diag(msg: &str) {
    crate::util::logfile::log("local-signals-mcp", msg);
}

/// Read and validate a job config. `runs_root`, when given, must contain the
/// configured runs dir (production: the app-data `local-signal-runs` root).
pub fn load_job_config(path: &Path, runs_root: Option<&Path>) -> Result<JobConfig, String> {
    let meta = std::fs::metadata(path).map_err(|_| "Job config missing")?;
    if !meta.is_file() || meta.len() > MAX_JOB_BYTES {
        return Err("Job config is not a small file".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "Cannot read job config")?;
    let cfg: JobConfig = serde_json::from_slice(&bytes).map_err(|_| "Invalid job config")?;
    if cfg.schema != JOB_SCHEMA {
        return Err("Unknown job config schema".into());
    }
    cfg.context.validate()?;
    if !valid_segment(&cfg.company_slug) || !valid_segment(&cfg.bot_id) {
        return Err("Invalid company or meeting".into());
    }
    let expected_provider = match cfg.provider {
        Provider::Claude => "claude",
        Provider::Codex => "codex",
    };
    if cfg.context.extractor_provider != expected_provider {
        return Err("Job provider does not match its context".into());
    }
    // The config must sit exactly where the app writes it for this job.
    let expected =
        extractor::job_config_path(&cfg.hq_root, &cfg.context.company_uid, &cfg.context.job_id)?;
    let same = match (path.canonicalize(), expected.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if !same {
        return Err("Job config is not in its run directory".into());
    }
    if let Some(root) = runs_root {
        let ok = match (cfg.runs_dir.canonicalize(), root.canonicalize()) {
            (Ok(d), Ok(r)) => d.starts_with(&r),
            _ => false,
        };
        if !ok {
            return Err("Job runs directory is not the app's".into());
        }
    }
    let job = runs::load(&cfg.runs_dir, &cfg.context.job_id)?;
    crate::commands::local_signals::context_matches(&job, &cfg.context)?;
    if !job.request.provider.accepts(cfg.provider) {
        return Err("This run asked for a different provider".into());
    }
    Ok(cfg)
}

/// Resolves the local transcript facts at submit time.
pub type TranscriptFn = Box<dyn Fn(&JobConfig) -> Result<LocalTranscript, String>>;

/// The production transcript: re-run the eligibility gate and require the
/// same source and digest the run was queued for.
pub fn eligibility_transcript(cfg: &JobConfig) -> Result<LocalTranscript, String> {
    let c = &cfg.context;
    let e = super::eligibility::evaluate(&cfg.hq_root, &c.company_uid, &c.member_uid, &cfg.bot_id);
    if !e.eligible
        || e.source_ref != c.source_ref
        || e.source_digest.as_deref() != Some(c.source_digest.as_str())
    {
        return Err("The meeting source changed or is no longer eligible".into());
    }
    Ok(LocalTranscript {
        source_ref: e.source_ref,
        source_digest: c.source_digest.clone(),
        duration_ms: e.duration_ms,
    })
}

pub struct Server {
    cfg: JobConfig,
    session_id: String,
    pid: Option<u32>,
    transcript: TranscriptFn,
    owner_alive: Box<dyn Fn(u32) -> bool>,
    claimed: bool,
    /// Parsed result committed to the personal store and run complete.
    finished: bool,
    host: Option<(ToolHost, PathBuf)>,
}

fn text_result(text: impl Into<String>, is_error: bool) -> Value {
    json!({"content":[{"type":"text","text":text.into()}],"isError":is_error})
}

fn json_result(v: &Value) -> Value {
    text_result(serde_json::to_string(v).unwrap_or_default(), false)
}

fn rpc_ok(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"result":result})
}

fn rpc_err(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
}

fn schema(props: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":props,"required":required,"additionalProperties":false})
}

/// The tool list. Nothing else is callable.
pub fn tool_descriptors() -> Vec<Value> {
    let types = json!({"type":"string","description":"person, company, project, concept, product, tool, platform, contact, or other"});
    vec![
        json!({"name":MCP_PROMPT_TOOL,"description":"Return the meeting signal extraction instructions and the meeting transcript for this job. Call this first.","inputSchema":schema(json!({}),&[])}),
        json!({"name":"ontology_list","description":"List company entities from the member's identity projection.","inputSchema":schema(json!({"type":types,"cursor":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":100}}),&[])}),
        json!({"name":"ontology_inspect","description":"Inspect one company entity by entityId returned from another lookup.","inputSchema":schema(json!({"entityId":{"type":"string"}}),&["entityId"])}),
        json!({"name":"ontology_search_alias","description":"Find company entities whose name or alias matches a mention.","inputSchema":schema(json!({"query":{"type":"string"},"type":types,"limit":{"type":"integer","minimum":1,"maximum":20}}),&["query"])}),
        json!({"name":"queue_entity_candidate","description":"Queue a provisional candidate for a name the lookups did not resolve. Returns a candidateId.","inputSchema":schema(json!({"name":{"type":"string"},"type":types}),&["name"])}),
        json!({"name":MCP_SUBMIT_TOOL,"description":"Deliver the extraction JSON object. It is validated; on failure the reasons are returned so you can fix and resubmit.","inputSchema":schema(json!({"result":{"type":"object"}}),&["result"])}),
    ]
}

impl Server {
    pub fn new(
        cfg: JobConfig,
        session_id: String,
        pid: Option<u32>,
        transcript: TranscriptFn,
        owner_alive: Box<dyn Fn(u32) -> bool>,
    ) -> Self {
        Server {
            cfg,
            session_id,
            pid,
            transcript,
            owner_alive,
            claimed: false,
            finished: false,
            host: None,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    fn job(&self) -> &str {
        &self.cfg.context.job_id
    }

    fn host(&mut self) -> Result<&mut (ToolHost, PathBuf), String> {
        if self.host.is_none() {
            let h = crate::commands::local_signals::host_for(
                &self.cfg.hq_root,
                &self.cfg.company_slug,
                &self.cfg.context,
            )?;
            self.host = Some(h);
        }
        Ok(self.host.as_mut().expect("host set"))
    }

    /// Claim or recover the run for this interactive session. A stored parse
    /// finishes immediately without another model call.
    fn claim(&mut self) -> Result<(), String> {
        let session = ProviderSession {
            provider: self.cfg.provider,
            session_id: self.session_id.clone(),
            interactive: true,
        };
        let plan = runs::recover(
            &self.cfg.runs_dir,
            self.job(),
            &session,
            self.pid,
            &self.owner_alive,
        )?;
        self.claimed = true;
        if plan.record.state == RunState::Complete {
            self.finished = true;
        } else if !plan.needs_model_call {
            let stored = runs::read_parsed_result(&self.cfg.runs_dir, self.job())?
                .ok_or("Stored result missing")?;
            self.commit(&stored)?;
        }
        Ok(())
    }

    /// Fail with a plain line when the member cancelled this run in HQ.
    fn ensure_extracting(&mut self) -> Result<(), String> {
        let rec = runs::load(&self.cfg.runs_dir, self.job())?;
        if rec.provider_session_id.as_deref() != Some(self.session_id.as_str()) {
            return Err("This run was cancelled or taken over in HQ. Stop here.".into());
        }
        match rec.state {
            RunState::Claimed => {
                runs::progress(
                    &self.cfg.runs_dir,
                    &rec.request.job_id,
                    &self.session_id,
                    RunState::Extracting,
                    None,
                )?;
                Ok(())
            }
            RunState::Extracting => Ok(()),
            RunState::Cancelled => Err("This run was cancelled in HQ. Stop here.".into()),
            RunState::Complete => Err("Signals for this meeting are already saved.".into()),
            _ => Err("This run is not extracting.".into()),
        }
    }

    fn commit(&mut self, output: &Value) -> Result<ExtractOutcome, String> {
        let transcript = (self.transcript)(&self.cfg)?;
        let dir = self.cfg.runs_dir.clone();
        let job = self.job().to_string();
        let sid = self.session_id.clone();
        let rec = runs::load(&dir, &job)?;
        if rec.state != RunState::Writing {
            runs::progress(&dir, &job, &sid, RunState::Writing, None)?;
        }
        let hq = self.cfg.hq_root.clone();
        let ctx = self.cfg.context.clone();
        let (host, _) = self.host()?;
        let out = extractor::extract_and_store(&hq, ctx, output, &transcript, host)?;
        if let ExtractOutcome::Stored {
            commit: CommitOutcome::Complete { .. } | CommitOutcome::Skipped { .. },
            ..
        } = out
        {
            runs::progress(&dir, &job, &sid, RunState::Complete, None)?;
            self.finished = true;
        }
        Ok(out)
    }

    fn prompt(&mut self) -> Result<Value, String> {
        self.ensure_extracting()?;
        let path =
            extractor::prompt_path(&self.cfg.hq_root, &self.cfg.context.company_uid, self.job())?;
        let meta = std::fs::metadata(&path).map_err(|_| "Prompt missing")?;
        if meta.len() > MAX_PROMPT_BYTES {
            return Err("Prompt too large".into());
        }
        let text = std::fs::read_to_string(&path).map_err(|_| "Cannot read prompt")?;
        Ok(text_result(text, false))
    }

    fn ontology(&mut self, tool: &str, input: &Value) -> Result<Value, String> {
        self.ensure_extracting()?;
        let (host, ledger) = self.host()?;
        match host.call(tool, input) {
            Ok(v) => {
                host.save_ledger(ledger)?;
                Ok(json_result(&v))
            }
            Err(e) => {
                host.save_ledger(ledger)?;
                Ok(text_result(e.to_string(), true))
            }
        }
    }

    fn submit(&mut self, input: &Value) -> Result<Value, String> {
        if self.finished {
            return Ok(text_result("Signals for this meeting are already saved.", false));
        }
        self.ensure_extracting()?;
        let output = input.get("result").cloned().unwrap_or(Value::Null);
        let transcript = (self.transcript)(&self.cfg)?;
        let hq = self.cfg.hq_root.clone();
        let ctx = self.cfg.context.clone();
        let failures: Option<Vec<GuardFailure>> = {
            let (host, _) = self.host()?;
            match extractor::validate_output(&output, &ctx, &transcript, host) {
                Ok(_) => None,
                Err(f) => Some(f),
            }
        };
        if let Some(f) = failures {
            extractor::write_diagnostics(&hq, &ctx, &f)?;
            let lines: Vec<String> = f
                .iter()
                .map(|g| match g.observation {
                    Some(i) => format!("- {} (observation {i}): {}", g.code, g.detail),
                    None => format!("- {}: {}", g.code, g.detail),
                })
                .collect();
            return Ok(text_result(
                format!(
                    "Not saved. Fix these and call {MCP_SUBMIT_TOOL} again:\n{}",
                    lines.join("\n")
                ),
                true,
            ));
        }
        runs::store_parsed_result(&self.cfg.runs_dir, self.job(), &self.session_id, &output)?;
        match self.commit(&output) {
            Ok(ExtractOutcome::Stored {
                commit:
                    CommitOutcome::Complete { output_ids, .. }
                    | CommitOutcome::Skipped { output_ids, .. },
                ..
            }) => Ok(text_result(
                format!(
                    "Saved {} signals on this device. You are done; HQ shows them in Meetings.",
                    output_ids.len()
                ),
                false,
            )),
            Ok(_) => Ok(text_result(
                "Your result is saved but could not be written yet. HQ will offer Resume.",
                true,
            )),
            Err(e) => {
                diag(&format!("commit failed for {}: {e}", self.job()));
                Ok(text_result(
                    "Your result is saved but could not be written yet. HQ will offer Resume.",
                    true,
                ))
            }
        }
    }

    fn call_tool(&mut self, params: &Value) -> Value {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        let args = params.get("arguments").cloned().unwrap_or(json!({}));
        let r = if name == MCP_PROMPT_TOOL {
            self.prompt()
        } else if name == MCP_SUBMIT_TOOL {
            self.submit(&args)
        } else if let Some((_, host_name)) = MCP_ONTOLOGY_TOOLS.iter().find(|(m, _)| *m == name) {
            self.ontology(host_name, &args)
        } else {
            Ok(text_result(
                format!("Tool not available: {}", name.chars().take(64).collect::<String>()),
                true,
            ))
        };
        r.unwrap_or_else(|e| text_result(e, true))
    }

    /// Handle one JSON-RPC message. Returns the response for requests.
    pub fn handle(&mut self, msg: &Value) -> Option<Value> {
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let id = id?; // notifications get no reply
        Some(match method {
            "initialize" => {
                if !self.claimed {
                    if let Err(e) = self.claim() {
                        diag(&format!("claim failed for {}: {e}", self.job()));
                        return Some(rpc_err(&id, -32000, "This signal run is not available."));
                    }
                }
                let version = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(PROTOCOL_FALLBACK);
                rpc_ok(
                    &id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": MCP_SERVER_NAME, "version": extractor::PROMPT_VERSION},
                        "instructions": format!("Call {MCP_PROMPT_TOOL} first, then deliver the JSON with {MCP_SUBMIT_TOOL}."),
                    }),
                )
            }
            "ping" => rpc_ok(&id, json!({})),
            "tools/list" => rpc_ok(&id, json!({"tools": tool_descriptors()})),
            "tools/call" => {
                if !self.claimed {
                    return Some(rpc_err(&id, -32002, "Not initialized"));
                }
                let r = self.call_tool(&params);
                rpc_ok(&id, r)
            }
            "resources/list" => rpc_ok(&id, json!({"resources": []})),
            "prompts/list" => rpc_ok(&id, json!({"prompts": []})),
            _ => rpc_err(&id, -32601, "Method not found"),
        })
    }

    /// stdin closed. Without a committed result the run is released as a
    /// transport loss so Meetings offers Resume; nothing else changes.
    pub fn on_eof(&mut self) {
        if !self.claimed || self.finished {
            return;
        }
        match runs::load(&self.cfg.runs_dir, self.job()) {
            Ok(rec) if rec.state.is_terminal() && rec.state != RunState::Failed => return,
            Ok(rec) if rec.provider_session_id.as_deref() != Some(self.session_id.as_str()) => {
                return
            }
            Err(_) => return,
            _ => {}
        }
        if let Err(e) = extractor::handle_provider_failure(
            &self.cfg.runs_dir,
            self.job(),
            &self.session_id,
            self.cfg.provider,
            ProviderFailure::TransportLost,
        ) {
            diag(&format!("release failed for {}: {e}", self.job()));
        }
    }

    /// Serve newline-delimited JSON-RPC until EOF.
    pub fn serve(&mut self, input: impl BufRead, mut output: impl Write) {
        let mut reader = input;
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(n) if n > MAX_LINE_BYTES => {
                    diag("oversized message dropped");
                    continue;
                }
                Ok(_) => {}
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let reply = match serde_json::from_str::<Value>(trimmed) {
                Ok(Value::Array(batch)) => {
                    let replies: Vec<Value> = batch.iter().filter_map(|m| self.handle(m)).collect();
                    (!replies.is_empty()).then(|| Value::Array(replies))
                }
                Ok(msg) => self.handle(&msg),
                Err(_) => Some(rpc_err(&Value::Null, -32700, "Parse error")),
            };
            if let Some(r) = reply {
                let ok = serde_json::to_string(&r)
                    .ok()
                    .map(|s| writeln!(output, "{s}").and_then(|_| output.flush()).is_ok())
                    .unwrap_or(false);
                if !ok {
                    break;
                }
            }
        }
        self.on_eof();
    }
}

fn production_runs_root() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("HQ/local-signal-runs"))
}

/// Run the server for `job_path`; returns the process exit code.
pub fn run(job_path: &Path) -> i32 {
    let root = production_runs_root();
    let cfg = match load_job_config(job_path, root.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            diag(&format!("job config rejected: {e}"));
            return 2;
        }
    };
    let pid = std::process::id();
    let session = format!("mcp-{pid}-{}", uuid::Uuid::new_v4());
    let mut server = Server::new(
        cfg,
        session,
        Some(pid),
        Box::new(eligibility_transcript),
        Box::new(runs::pid_alive),
    );
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    server.serve(stdin.lock(), stdout.lock());
    0
}

/// `main()` calls this first. Exits the process when the MCP mode is
/// requested; returns otherwise so the app starts normally.
pub fn run_if_requested() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(MCP_ARG) {
        return;
    }
    let code = match args.get(2) {
        Some(p) if args.len() == 3 => run(Path::new(p)),
        _ => 2,
    };
    std::process::exit(code);
}

#[cfg(test)]
#[path = "signals_local_meetings_v1_us007_mcp_tests.rs"]
mod tests;
