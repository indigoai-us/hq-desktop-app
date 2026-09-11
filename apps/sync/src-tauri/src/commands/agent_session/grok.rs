//! The Grok driver: one `grok --no-auto-update agent --no-leader stdio` child,
//! one task, one live session.
//!
//! Structurally the twin of [`super::codex`] — same [`Outbound`] channel, same
//! `select!` reduced to a [`Step`] value, same [`SessionEventSink`], same
//! auto-allow-before-the-UI-hears-about-it rule — over Grok Build's ACP
//! JSON-RPC wire.
//!
//! Grok has no mid-turn steer: a line typed while a turn is running is queued
//! and delivered as the next `session/prompt` at the turn boundary. Interrupt
//! is `session/cancel`. `_x.ai/session/prompt_complete` is the authoritative
//! turn end — grok's `session/prompt` RPC can hang after the turn finished.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use hq_desktop_core::agent_session::grok_normalize::{options_from_event, GrokNormalizer};
use hq_desktop_core::agent_session::grok_wire::{
    first_class_model_change, initialize_params, login_status_from_models, parse_current_model,
    parse_models_cli, parse_session_id, permission_reply,
    prompt_from_line, scan_available_commands, session_cancel_params, session_load_params,
    session_new_params, session_prompt_params, session_set_config_option_params,
    session_set_model_params, thought_level_config_id, usage_from_prompt, PermissionOption,
    ACP_ARGS,
};
use hq_desktop_core::agent_session::registry::{decide_can_use_tool, AutoDecision};
use hq_desktop_core::agent_session::types::{
    PermissionDecision, SessionEvent, SessionSpec, SessionTool, SlashCommand,
};
use hq_desktop_core::paths;
use hq_desktop_core::stdio::child::REAP_TIMEOUT;
use hq_desktop_core::stdio::{StdioChild, StdioError, StdioLaunch};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::util::logfile::log;

use super::claude::{CommandCatalog, Outbound, SessionEventSink};
use super::{driver_idle_timeout, now_iso, now_ms, SessionState, SESSION_HARD_DEADLINE};

const LOG_TAG: &str = "agent-session";

const INTERRUPT_GRACE: Duration = Duration::from_secs(10);
const EXIT_GRACE: Duration = Duration::from_secs(5);
const PROBE_BUDGET: Duration = Duration::from_secs(20);
const REQUEST_ID_BASE: u64 = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// Launch
// ─────────────────────────────────────────────────────────────────────────────

pub fn grok_launch(program: String, cwd: PathBuf) -> StdioLaunch {
    StdioLaunch {
        program,
        args: ACP_ARGS.iter().map(|a| (*a).to_owned()).collect(),
        env: vec![("PATH".to_string(), paths::child_path())],
        env_remove: inherited_agent_env(),
        cwd,
    }
}

fn inherited_agent_env() -> Vec<String> {
    let mut names: Vec<String> = std::env::vars_os()
        .filter_map(|(key, _)| key.into_string().ok())
        .filter(|key| {
            key.starts_with("CLAUDE") || key.starts_with("CODEX") || key.starts_with("GROK")
        })
        .collect();
    names.push("HQ_SESSION_ID".to_string());
    names.sort();
    names.dedup();
    names
}

pub fn grok_program() -> String {
    let binary = crate::commands::launch::cli_binary_for("grok").unwrap_or("grok");
    paths::resolve_bin(binary)
}

pub async fn spawn_grok(cwd: PathBuf) -> Result<StdioChild, String> {
    let launch = grok_launch(grok_program(), cwd);
    log(
        LOG_TAG,
        &format!("spawn grok program={} args={:?}", launch.program, launch.args),
    );
    StdioChild::spawn(&launch)
        .await
        .map_err(|e| format!("Could not start Grok: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Handshake
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GrokHandshake {
    pub session_id: String,
    pub model: String,
    pub commands: Vec<SlashCommand>,
    pub thought_level_id: Option<String>,
}

pub async fn handshake(
    child: &mut StdioChild,
    spec: &SessionSpec,
) -> Result<GrokHandshake, String> {
    let init = child
        .send_request("initialize", initialize_params(env!("CARGO_PKG_VERSION")))
        .await
        .map_err(|e| format!("Grok did not answer the handshake: {e}"))?;
    let mut commands = scan_available_commands(&init);

    let mut started = None;
    if let Some(resume) = spec
        .resume
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        match child
            .send_request("session/load", session_load_params(&spec.cwd, resume))
            .await
        {
            Ok(result) if !parse_session_id(&result).is_empty() => started = Some(result),
            Ok(_) | Err(_) => log(
                LOG_TAG,
                &format!("grok resume of {resume} refused — starting a fresh session"),
            ),
        }
    }

    let session = match started {
        Some(session) => session,
        None => child
            .send_request("session/new", session_new_params(&spec.cwd))
            .await
            .map_err(|e| format!("Grok could not start a session: {e}"))?,
    };
    let session_id = parse_session_id(&session);
    if session_id.is_empty() {
        return Err("Grok started a session without an id.".into());
    }
    if commands.is_empty() {
        commands = scan_available_commands(&session);
    }

    if let Some(model) = first_class_model_change(&session, spec.model.as_deref()) {
        if let Err(e) = child
            .send_request(
                "session/set_model",
                session_set_model_params(&session_id, &model),
            )
            .await
        {
            return Err(format!("Grok rejected model switch to {model}: {e}"));
        }
    }

    let thought_level_id = thought_level_config_id(&session);
    if let (Some(config_id), Some(effort)) = (thought_level_id.as_deref(), spec.effort.as_deref()) {
        if let Err(e) = child
            .send_request(
                "session/set_config_option",
                session_set_config_option_params(&session_id, config_id, effort),
            )
            .await
        {
            log(
                LOG_TAG,
                &format!("grok thought_level={effort} rejected (agent default runs): {e}"),
            );
        }
    }

    let model = spec
        .model
        .clone()
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| parse_current_model(&session));

    Ok(GrokHandshake {
        session_id,
        model,
        commands,
        thought_level_id,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// The session loop
// ─────────────────────────────────────────────────────────────────────────────

enum Step {
    Out(Option<Outbound>),
    Frame(Result<Option<Value>, StdioError>),
    InterruptTimedOut,
}

struct Ending {
    error: Option<String>,
    crash_class: bool,
}

struct Turns {
    grok_session_id: String,
    model: Option<String>,
    effort: Option<String>,
    thought_level_id: Option<String>,
    active: bool,
    next_id: u64,
    pending_prompt: Option<u64>,
    queued: VecDeque<(String, Vec<(String, String)>)>,
    server_requests: HashMap<String, Value>,
    permission_options: HashMap<String, Vec<PermissionOption>>,
}

impl Turns {
    fn id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}

pub async fn run_session_loop(
    mut child: StdioChild,
    session_id: String,
    spec: SessionSpec,
    handshake: GrokHandshake,
    state: Arc<Mutex<SessionState>>,
    sink: Arc<dyn SessionEventSink>,
    mut outbound: UnboundedReceiver<Outbound>,
) {
    let mut turns = Turns {
        grok_session_id: handshake.session_id.clone(),
        model: spec.model.clone(),
        effort: spec.effort.clone(),
        thought_level_id: handshake.thought_level_id.clone(),
        active: false,
        next_id: REQUEST_ID_BASE,
        pending_prompt: None,
        queued: VecDeque::new(),
        server_requests: HashMap::new(),
        permission_options: HashMap::new(),
    };
    let mut normalizer = GrokNormalizer::new();
    let hard_deadline = Instant::now() + SESSION_HARD_DEADLINE;
    let mut interrupt_deadline: Option<Instant> = None;
    let mut ending = Ending {
        error: None,
        crash_class: false,
    };

    record(
        &session_id,
        &state,
        &sink,
        SessionEvent::Started {
            session_id: handshake.session_id.clone(),
            tool: SessionTool::Grok,
            model: handshake.model.clone(),
            cwd: spec.cwd.clone(),
            tools: Vec::new(),
            commands: handshake.commands.clone(),
            permission_mode: Some(
                if spec.permission_mode
                    == hq_desktop_core::agent_session::types::PermissionMode::BypassAll
                {
                    "bypassPermissions".into()
                } else {
                    "default".into()
                },
            ),
            capabilities: vec!["session_cancel".into(), "prompt_complete".into()],
        },
    )
    .await;

    loop {
        let force_at = interrupt_deadline.unwrap_or_else(|| Instant::now() + SESSION_HARD_DEADLINE);
        let frame_idle_timeout = {
            let guard = state.lock().await;
            driver_idle_timeout(guard.registry.get(&session_id).map(|session| session.phase))
        };

        let step = tokio::select! {
            biased;
            msg = outbound.recv() => Step::Out(msg),
            _ = tokio::time::sleep_until(force_at), if interrupt_deadline.is_some() => {
                Step::InterruptTimedOut
            }
            frame = child.next_frame(frame_idle_timeout, hard_deadline) => Step::Frame(frame),
        };

        match step {
            Step::Out(None) => break,

            Step::Out(Some(Outbound::Line(line))) => {
                let (text, images) = prompt_from_line(&line);
                if let Err(e) = send_or_queue(&mut child, &mut turns, text, images).await {
                    ending = Ending {
                        error: Some(format!("Could not send to Grok: {e}")),
                        crash_class: e.is_crash_class(),
                    };
                    break;
                }
            }

            Step::Out(Some(Outbound::Reply { request_id, result })) => {
                let Some(id) = turns.server_requests.remove(&request_id) else {
                    log(
                        LOG_TAG,
                        &format!("session={session_id} reply for unknown request {request_id}"),
                    );
                    continue;
                };
                let options = turns
                    .permission_options
                    .remove(&request_id)
                    .unwrap_or_default();
                let decision = serde_json::from_value::<PermissionDecision>(result)
                    .unwrap_or(PermissionDecision::Deny {
                        message: "Could not read the decision.".into(),
                    });
                if let Err(e) =
                    write_response(&mut child, &id, permission_reply(&options, &decision)).await
                {
                    ending = Ending {
                        error: Some(format!("Could not answer Grok: {e}")),
                        crash_class: e.is_crash_class(),
                    };
                    break;
                }
            }

            Step::Out(Some(Outbound::SetTurnOptions(overrides))) => {
                turns.model = overrides.model.clone();
                turns.effort = overrides.effort.clone();
                if !turns.active {
                    if let Err(e) = apply_turn_options(&mut child, &mut turns).await {
                        log(
                            LOG_TAG,
                            &format!("session={session_id} grok turn options rejected: {e}"),
                        );
                    }
                }
            }

            Step::Out(Some(Outbound::SetPermissionMode(_))) => {}

            Step::Out(Some(Outbound::Interrupt)) => {
                normalizer.mark_interrupted();
                if !turns.active {
                    continue;
                }
                if let Err(e) = child
                    .send_notification(
                        "session/cancel",
                        session_cancel_params(&turns.grok_session_id),
                    )
                    .await
                {
                    ending = Ending {
                        error: Some(format!("Could not interrupt Grok: {e}")),
                        crash_class: e.is_crash_class(),
                    };
                    break;
                }
                interrupt_deadline = Some(Instant::now() + INTERRUPT_GRACE);
            }

            Step::Out(Some(Outbound::End)) => {
                child.close_stdin().await;
            }

            Step::Out(Some(Outbound::Kill)) => {
                child.shutdown_with_reap(REAP_TIMEOUT).await;
                break;
            }

            Step::InterruptTimedOut => {
                log(
                    LOG_TAG,
                    &format!("session={session_id} ignored an interrupt — killing it"),
                );
                child.shutdown_with_reap(REAP_TIMEOUT).await;
                ending = Ending {
                    error: Some("Grok did not respond to the interrupt.".into()),
                    crash_class: true,
                };
                break;
            }

            Step::Frame(Ok(Some(value))) => {
                match handle_frame(
                    &mut child,
                    &session_id,
                    &state,
                    &sink,
                    &mut normalizer,
                    &mut turns,
                    &value,
                )
                .await
                {
                    Ok(turn_ended) => {
                        if turn_ended {
                            interrupt_deadline = None;
                        }
                    }
                    Err(message) => {
                        ending = Ending {
                            error: Some(message),
                            crash_class: true,
                        };
                        break;
                    }
                }
            }

            Step::Frame(Ok(None)) => break,

            Step::Frame(Err(e)) => {
                ending = Ending {
                    error: Some(match &e {
                        StdioError::IdleTimeout(_) => {
                            "Grok stopped responding during this turn. You can resume it from session history.".into()
                        }
                        other => format!("Grok stopped responding: {other}"),
                    }),
                    crash_class: e.is_crash_class(),
                };
                break;
            }
        }
    }

    finish(child, session_id, state, sink, ending).await;
}

async fn send_or_queue(
    child: &mut StdioChild,
    turns: &mut Turns,
    text: String,
    images: Vec<(String, String)>,
) -> Result<(), StdioError> {
    if turns.active {
        turns.queued.push_back((text, images));
        return Ok(());
    }
    start_prompt(child, turns, text, images).await
}

async fn start_prompt(
    child: &mut StdioChild,
    turns: &mut Turns,
    text: String,
    images: Vec<(String, String)>,
) -> Result<(), StdioError> {
    apply_turn_options(child, turns).await?;
    let id = turns.id();
    let prompt_id = format!("p-{id}");
    let request = request_frame(
        id,
        "session/prompt",
        session_prompt_params(
            &turns.grok_session_id,
            &text,
            &images,
            Some(&prompt_id),
        ),
    );
    turns.active = true;
    turns.pending_prompt = Some(id);
    child.write_ndjson(&request).await
}

async fn apply_turn_options(child: &mut StdioChild, turns: &mut Turns) -> Result<(), StdioError> {
    let model = turns
        .model
        .clone()
        .filter(|id| !id.is_empty());
    let session_id = turns.grok_session_id.clone();
    let thought_level_id = turns.thought_level_id.clone();
    let effort = turns.effort.clone().filter(|value| !value.is_empty());
    if let Some(model) = model {
        let id = turns.id();
        child
            .write_ndjson(&request_frame(
                id,
                "session/set_model",
                session_set_model_params(&session_id, &model),
            ))
            .await?;
    }
    if let (Some(config_id), Some(effort)) = (thought_level_id, effort) {
        let id = turns.id();
        child
            .write_ndjson(&request_frame(
                id,
                "session/set_config_option",
                session_set_config_option_params(&session_id, &config_id, &effort),
            ))
            .await?;
    }
    Ok(())
}

fn request_frame(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

async fn write_response(
    child: &mut StdioChild,
    id: &Value,
    result: Value,
) -> Result<(), StdioError> {
    child
        .write_ndjson(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
        .await
}

async fn handle_frame(
    child: &mut StdioChild,
    session_id: &str,
    state: &Arc<Mutex<SessionState>>,
    sink: &Arc<dyn SessionEventSink>,
    normalizer: &mut GrokNormalizer,
    turns: &mut Turns,
    msg: &Value,
) -> Result<bool, String> {
    let method = msg.get("method").and_then(Value::as_str);
    let id = msg.get("id");

    if method.is_none() {
        if let Some(id) = id.and_then(Value::as_u64) {
            return handle_response(child, session_id, state, sink, normalizer, turns, id, msg)
                .await;
        }
        return Ok(false);
    }
    let method = method.unwrap_or_default();

    if let Some(id) = id {
        let key = hq_desktop_core::agent_session::grok_wire::request_key(id);
        let events = normalizer.normalize(msg);
        if events.is_empty() {
            let _ = child
                .write_ndjson(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("unsupported method: {method}") },
                }))
                .await;
            return Ok(false);
        }
        turns.server_requests.insert(key.clone(), id.clone());
        if let Some(event) = events.iter().find(|event| {
            matches!(event, SessionEvent::PermissionRequest { .. })
        }) {
            turns
                .permission_options
                .insert(key, options_from_event(event));
        }
        for event in events {
            if !handle_event(child, session_id, state, sink, turns, event).await {
                return Err("Lost the connection to Grok.".into());
            }
        }
        return Ok(false);
    }

    let mut turn_ended = false;
    let events = normalizer.normalize(msg);
    for event in events {
        if matches!(event, SessionEvent::TurnDone { .. }) {
            turn_ended = true;
            turns.active = false;
            turns.pending_prompt = None;
        }
        if !handle_event(child, session_id, state, sink, turns, event).await {
            return Err("Lost the connection to Grok.".into());
        }
    }

    if turn_ended {
        if let Some((text, images)) = turns.queued.pop_front() {
            start_prompt(child, turns, text, images)
                .await
                .map_err(|e| format!("Could not deliver the queued message to Grok: {e}"))?;
        }
    }
    Ok(turn_ended)
}

async fn handle_response(
    child: &mut StdioChild,
    session_id: &str,
    state: &Arc<Mutex<SessionState>>,
    sink: &Arc<dyn SessionEventSink>,
    normalizer: &mut GrokNormalizer,
    turns: &mut Turns,
    id: u64,
    msg: &Value,
) -> Result<bool, String> {
    if turns.pending_prompt != Some(id) {
        return Ok(false);
    }
    turns.pending_prompt = None;
    if turns.active {
        // prompt_complete may already have ended the turn.
        let result = msg.get("result").cloned().unwrap_or(Value::Null);
        if let Some((input, output)) = usage_from_prompt(&result) {
            if !handle_event(
                child,
                session_id,
                state,
                sink,
                turns,
                SessionEvent::Usage {
                    input_tokens: input,
                    output_tokens: output,
                    cost_usd: None,
                    duration_ms: None,
                },
            )
            .await
            {
                return Err("Lost the connection to Grok.".into());
            }
        }
        if turns.active {
            let event = if let Some(error) = msg.get("error") {
                SessionEvent::TurnDone {
                    status: if normalizer.is_interrupted() {
                        hq_desktop_core::agent_session::types::DoneStatus::Interrupted
                    } else {
                        hq_desktop_core::agent_session::types::DoneStatus::Error
                    },
                    error: Some(error.to_string()),
                    session_id: None,
                }
            } else {
                normalizer.turn_from_prompt(&result)
            };
            turns.active = false;
            if !handle_event(child, session_id, state, sink, turns, event).await {
                return Err("Lost the connection to Grok.".into());
            }
            if let Some((text, images)) = turns.queued.pop_front() {
                start_prompt(child, turns, text, images)
                    .await
                    .map_err(|e| format!("Could not deliver the queued message to Grok: {e}"))?;
            }
            return Ok(true);
        }
    }
    Ok(false)
}

async fn handle_event(
    child: &mut StdioChild,
    session_id: &str,
    state: &Arc<Mutex<SessionState>>,
    sink: &Arc<dyn SessionEventSink>,
    turns: &mut Turns,
    event: SessionEvent,
) -> bool {
    if let SessionEvent::PermissionRequest {
        request_id,
        tool_name,
        ..
    } = &event
    {
        let auto = {
            let guard = state.lock().await;
            guard
                .registry
                .get(session_id)
                .map(|session| decide_can_use_tool(session, tool_name))
                .unwrap_or(AutoDecision::Ask)
        };
        if auto == AutoDecision::Allow {
            let Some(id) = turns.server_requests.remove(request_id) else {
                return true;
            };
            let options = turns
                .permission_options
                .remove(request_id)
                .unwrap_or_default();
            if let Err(e) = write_response(
                child,
                &id,
                permission_reply(&options, &PermissionDecision::AllowOnce),
            )
            .await
            {
                log(
                    LOG_TAG,
                    &format!("session={session_id} auto-approve write failed: {e}"),
                );
                return false;
            }
            return true;
        }
    }

    let outcome = {
        let mut guard = state.lock().await;
        let Some(session) = guard.registry.get_mut(session_id) else {
            return true;
        };
        session.on_event(event.clone(), now_iso(), now_ms())
    };
    let Some(outcome) = outcome else {
        return true;
    };

    sink.emit_event(session_id, outcome.seq, outcome.received_at_ms, &event);
    if let Some(change) = outcome.phase_change {
        sink.emit_phase(session_id, change);
    }
    if let Some(needs) = &outcome.needs_you {
        sink.emit_needs_you(session_id, needs);
    }
    true
}

async fn record(
    session_id: &str,
    state: &Arc<Mutex<SessionState>>,
    sink: &Arc<dyn SessionEventSink>,
    event: SessionEvent,
) {
    let outcome = {
        let mut guard = state.lock().await;
        let Some(session) = guard.registry.get_mut(session_id) else {
            return;
        };
        session.on_event(event.clone(), now_iso(), now_ms())
    };
    let Some(outcome) = outcome else {
        return;
    };
    sink.emit_event(session_id, outcome.seq, outcome.received_at_ms, &event);
    if let Some(change) = outcome.phase_change {
        sink.emit_phase(session_id, change);
    }
}

async fn finish(
    mut child: StdioChild,
    session_id: String,
    state: Arc<Mutex<SessionState>>,
    sink: Arc<dyn SessionEventSink>,
    ending: Ending,
) {
    let status = child.wait_for_exit(EXIT_GRACE).await;
    if status.is_none() {
        child.shutdown_with_reap(REAP_TIMEOUT).await;
    }

    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.and_then(|s| s.signal())
    };
    #[cfg(not(unix))]
    let signal: Option<i32> = None;

    if let Some(message) = ending.error {
        record(
            &session_id,
            &state,
            &sink,
            SessionEvent::Error {
                message,
                code: None,
            },
        )
        .await;
    }

    record(
        &session_id,
        &state,
        &sink,
        SessionEvent::Exited {
            code: status.and_then(|s| s.code()),
            signal,
        },
    )
    .await;

    let mut guard = state.lock().await;
    guard.close_channel(&session_id);
    if ending.crash_class {
        if let Some(session) = guard.registry.get_mut(&session_id) {
            let verdict = session.circuit.record_crash();
            log(
                LOG_TAG,
                &format!("session={session_id} crash recorded, verdict={verdict:?}"),
            );
        }
    }
    log(LOG_TAG, &format!("session={session_id} loop finished"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Command catalog probe
// ─────────────────────────────────────────────────────────────────────────────

/// Live model list from `grok models`. Commands come from the session
/// handshake (`availableCommands`); the composer probe does not wait on
/// Grok's session_start hooks.
pub async fn probe_command_catalog(_cwd: PathBuf) -> Result<CommandCatalog, String> {
    let program = grok_program();
    let output = tokio::time::timeout(PROBE_BUDGET, run_models(&program))
        .await
        .map_err(|_| "Grok did not answer the model probe in time.".to_owned())?
        .map_err(|e| format!("Could not load Grok models: {e}"))?;
    let models = parse_models_cli(&output);
    if models.is_empty() {
        return Err("Grok returned no available models. Check its sign-in and retry.".into());
    }
    Ok(CommandCatalog {
        commands: Vec::new(),
        models,
    })
}

async fn run_models(program: &str) -> Result<String, String> {
    let mut command = paths::tokio_spawn_command(program, &["models"]);
    command.env("PATH", paths::child_path());
    let output = command
        .output()
        .await
        .map_err(|e| format!("Could not run grok models: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(format!("{stdout}{stderr}"))
}

/// Shared with [`super::provider_auth`]: `grok models` reports sign-in on
/// stdout (`You are logged in with grok.com.`).
pub(super) fn login_status_succeeded(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<bool, ()> {
    login_status_from_models(success, stdout, stderr)
}

/// Catalog rows from an ACP `session/new` result — used by tests and as a
/// fallback if a future probe wants the richer wire shape.
#[cfg(test)]
pub fn models_from_session_result(session: &Value) -> Vec<Value> {
    hq_desktop_core::agent_session::grok_wire::parse_models_from_session(session)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::agent_session::registry::{LiveSession, NeedsYou, PhaseChange};
    use hq_desktop_core::agent_session::types::{
        DoneStatus, PermissionDecision, PermissionMode, SessionEvent, SessionPhase, SessionTool,
    };
    use serde_json::json;
    use tokio::sync::mpsc;

    #[test]
    fn launch_uses_no_leader_acp_stdio() {
        let launch = grok_launch("/usr/bin/grok".into(), PathBuf::from("/hq"));
        assert_eq!(
            launch.args,
            vec![
                "--no-auto-update".to_string(),
                "agent".to_string(),
                "--no-leader".to_string(),
                "stdio".to_string()
            ]
        );
    }

    #[derive(Default)]
    struct RecordingSink {
        events: std::sync::Mutex<Vec<(u64, SessionEvent)>>,
        phases: std::sync::Mutex<Vec<PhaseChange>>,
        needs: std::sync::Mutex<Vec<NeedsYou>>,
    }

    impl RecordingSink {
        fn events(&self) -> Vec<(u64, SessionEvent)> {
            self.events.lock().unwrap().clone()
        }
        fn needs(&self) -> Vec<NeedsYou> {
            self.needs.lock().unwrap().clone()
        }
    }

    impl SessionEventSink for Arc<RecordingSink> {
        fn emit_event(
            &self,
            _session_id: &str,
            seq: u64,
            _received_at_ms: u64,
            event: &SessionEvent,
        ) {
            self.events.lock().unwrap().push((seq, event.clone()));
        }
        fn emit_phase(&self, _session_id: &str, change: PhaseChange) {
            self.phases.lock().unwrap().push(change);
        }
        fn emit_needs_you(&self, _session_id: &str, needs: &NeedsYou) {
            self.needs.lock().unwrap().push(needs.clone());
        }
    }

    fn spec() -> SessionSpec {
        SessionSpec {
            session_id: "sess-gk".into(),
            title: None,
            tool: SessionTool::Grok,
            cwd: "/hq".into(),
            company: Some("indigo".into()),
            project: None,
            model: Some("grok-4.6".into()),
            effort: None,
            resume: None,
            permission_mode: PermissionMode::Prompt,
        }
    }

    const FAKE_GROK: &str = r#"
const init = await take();
respond(init, {protocolVersion:1, agentCapabilities:{}});
const created = await take();
respond(created, {sessionId:"gk-1", models:{
  currentModelId:"grok-4.6",
  availableModels:[{modelId:"grok-4.6",name:"Grok 4.6"},{modelId:"grok-4.5",name:"Grok 4.5"}]
}});
const maybeModel = await take();
if (maybeModel.method === "session/set_model") respond(maybeModel, {});
const prompt = maybeModel.method === "session/prompt" ? maybeModel : await take();
emit({jsonrpc:"2.0", method:"session/update", params:{sessionId:"gk-1", update:{
  sessionUpdate:"agent_message_chunk", content:{type:"text", text:"Hello from Grok."}
}}});
emit({jsonrpc:"2.0", method:"session/update", params:{sessionId:"gk-1", update:{
  sessionUpdate:"tool_call", toolCallId:"bash-1", kind:"execute", title:"bash",
  rawInput:{command:"ls"}, status:"pending"
}}});
emit({jsonrpc:"2.0", id:0, method:"session/request_permission", params:{
  sessionId:"gk-1",
  toolCall:{toolCallId:"bash-1", title:"bash", rawInput:{command:"ls"}},
  options:[
    {optionId:"once", name:"Once", kind:"allow_once"},
    {optionId:"always", name:"Always", kind:"allow_always"}
  ]
}});
const reply = await take();
emit({jsonrpc:"2.0", method:"session/update", params:{sessionId:"gk-1", update:{
  sessionUpdate:"tool_call_update", toolCallId:"bash-1", status:"completed",
  content:[{type:"content", content:{type:"text", text:"ok"}}]
}}});
emit({jsonrpc:"2.0", method:"_x.ai/session/prompt_complete", params:{sessionId:"gk-1", _meta:{promptId:"p-1000"}}});
respond(prompt, {stopReason:"end_turn", _meta:{inputTokens:3, outputTokens:5}});
await drain();
"#;

    fn install_fake(dir: &std::path::Path, replies: &std::path::Path, script: &str) -> String {
        let path = dir.join("fake-grok.cjs");
        let runtime = r#"
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({input: process.stdin});
const queue = [];
let waiter;
let closed = false;
input.on("line", line => { if (waiter) { const resolve = waiter; waiter = null; resolve(line); } else queue.push(line); });
input.on("close", () => { closed = true; if (waiter) process.exit(0); });
async function take() {
  const line = queue.length ? queue.shift() : closed ? process.exit(0) : await new Promise(resolve => waiter = resolve);
  fs.appendFileSync(replies, line + "\n");
  return JSON.parse(line);
}
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const respond = (request, result) => emit({jsonrpc:"2.0",id:request.id,result});
async function drain() { while (!closed || queue.length) await take(); }
"#;
        std::fs::write(
            &path,
            format!(
                "const replies = {};\n{runtime}\n(async () => {{\n{script}\n}})().catch(error => {{ console.error(error); process.exit(1); }});\n",
                serde_json::to_string(&replies.to_string_lossy()).unwrap(),
            ),
        )
        .expect("write fake");
        path.to_string_lossy().into_owned()
    }

    fn fake_launch(script: String, cwd: PathBuf) -> StdioLaunch {
        let mut launch = grok_launch(paths::resolve_bin("node"), cwd);
        launch.args.insert(0, script);
        launch
    }

    struct Harness {
        state: Arc<Mutex<SessionState>>,
        sink: Arc<RecordingSink>,
        tx: mpsc::UnboundedSender<Outbound>,
        _join: tokio::task::JoinHandle<()>,
        _dir: tempfile::TempDir,
    }

    impl RecordingSink {
        fn phases(&self) -> Vec<SessionPhase> {
            self.phases.lock().unwrap().iter().map(|c| c.to).collect()
        }
    }

    async fn until(label: &str, mut predicate: impl FnMut() -> bool) {
        for _ in 0..400 {
            if predicate() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("timed out waiting for {label}");
    }

    async fn start_with(script: &str) -> Harness {
        super::super::warm_up_agent_session_node().await;

        let dir = tempfile::tempdir().unwrap();
        let replies = dir.path().join("replies.jsonl");
        let program = install_fake(dir.path(), &replies, script);
        let mut child = StdioChild::spawn(&fake_launch(program, dir.path().into()))
            .await
            .expect("spawn fake grok");
        let spec = spec();
        let handshake = tokio::time::timeout(Duration::from_secs(5), handshake(&mut child, &spec))
            .await
            .expect("handshake timeout")
            .expect("handshake");
        let state = Arc::new(Mutex::new(SessionState::default()));
        {
            let mut guard = state.lock().await;
            guard
                .registry
                .insert(LiveSession::new(spec.clone(), now_iso()))
                .expect("insert");
        }
        let sink = Arc::new(RecordingSink::default());
        let (tx, rx) = mpsc::unbounded_channel();
        let join = tokio::spawn(run_session_loop(
            child,
            spec.session_id.clone(),
            spec,
            handshake,
            state.clone(),
            Arc::new(sink.clone()) as Arc<dyn SessionEventSink>,
            rx,
        ));
        Harness {
            state,
            sink,
            tx,
            _join: join,
            _dir: dir,
        }
    }

    #[tokio::test]
    async fn a_prompted_session_parks_a_grok_permission_and_resumes_when_accepted() {
        let h = start_with(FAKE_GROK).await;
        until("the handshake event", || !h.sink.events().is_empty()).await;
        assert!(
            matches!(&h.sink.events()[0].1, SessionEvent::Started { session_id, tool, model, .. }
                if session_id == "gk-1"
                    && *tool == SessionTool::Grok
                    && model == "grok-4.6"),
            "first event should be Started: {:?}",
            h.sink.events()[0].1
        );

        h.tx.send(Outbound::Line("hello grok".into()))
            .expect("send turn");
        until("the permission request", || !h.sink.needs().is_empty()).await;

        let events = h.sink.events();
        assert!(
            events.iter().any(|(_, e)| matches!(
                e,
                SessionEvent::TextDelta { text, .. } if text == "Hello from Grok."
            )),
            "streamed text: {events:?}"
        );
        assert_eq!(h.sink.needs()[0].reason, "permission");
        assert_eq!(h.sink.needs()[0].request_id, "0");

        h.tx.send(Outbound::Reply {
            request_id: "0".into(),
            result: serde_json::to_value(PermissionDecision::AllowOnce).unwrap(),
        })
        .expect("reply");

        until("turn done", || {
            h.sink.events().iter().any(|(_, e)| {
                matches!(e, SessionEvent::TurnDone { status: DoneStatus::Success, .. })
            })
        })
        .await;
        assert!(h
            .sink
            .events()
            .iter()
            .any(|(_, e)| matches!(e, SessionEvent::ToolResult { id, .. } if id == "bash-1")));
        assert!(h.sink.phases().contains(&SessionPhase::Idle));
        let _ = h.tx.send(Outbound::End);
        let _ = h.state.lock().await;
    }

    #[test]
    fn session_models_from_acp_match_composer_shape() {
        let session = json!({
            "models": {
                "currentModelId": "grok-4.6",
                "availableModels": [
                    { "modelId": "grok-4.6", "name": "Grok 4.6" },
                    { "modelId": "grok-4.5", "name": "Grok 4.5" }
                ]
            }
        });
        let models = models_from_session_result(&session);
        assert_eq!(models[0]["value"], "grok-4.6");
        assert_eq!(models[1]["displayName"], "Grok 4.5");
    }
}
