//! The Codex driver: one `codex app-server` child, one task, one live session.
//!
//! Structurally the twin of [`super::claude`] — same [`Outbound`] channel, same
//! `select!` reduced to a [`Step`] value, same [`SessionEventSink`], same
//! auto-allow-before-the-UI-hears-about-it rule — over a different wire.
//!
//! # Why the loop owns request ids
//!
//! [`StdioChild::send_request`] round-trips a request by draining and
//! DISCARDING every frame until the matching response. That is exactly right
//! for the handshake, where the only traffic is bookkeeping, and exactly wrong
//! once a turn is running: it would eat the notifications that ARE the
//! transcript. So the loop mints its own ids from [`REQUEST_ID_BASE`], writes
//! requests as plain frames, and pairs the responses itself.
//!
//! # Steering, and why a rejected steer is not a failure
//!
//! A line typed while a turn is running is `turn/steer`, which carries
//! `expectedTurnId` as a server-checked precondition. The common rejection is
//! that the turn finished between the click and the write — so a rejected
//! steer is re-queued as the next `turn/start` rather than surfaced. Losing
//! that race must not lose the user's words.
//!
//! # Approvals
//!
//! Codex asks with a server→client REQUEST carrying a JSON-RPC id, and blocks
//! until it gets a response on that id. The id is what the registry parks the
//! request under (as a string), and the driver keeps the id → wire-id map so
//! [`Outbound::Reply`] can answer it. An unsupported server request is refused
//! with a JSON-RPC error rather than ignored: an ignored request wedges the
//! app server forever.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use hq_desktop_core::agent_session::codex_normalize::request_key;
use hq_desktop_core::agent_session::codex_wire::{
    approval_reply, initialize_params, parse_model_list, parse_skills_list, parse_thread_started,
    parse_turn_started, policy_for, thread_resume_params, thread_start_params,
    turn_interrupt_params, turn_start_params, turn_steer_params, user_input,
};
use hq_desktop_core::agent_session::registry::{decide_can_use_tool, AutoDecision};
use hq_desktop_core::agent_session::types::{SessionEvent, SessionSpec, SessionTool, SlashCommand};
use hq_desktop_core::agent_session::CodexNormalizer;
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

/// How long `turn/interrupt` gets to produce a turn end before we stop asking.
const INTERRUPT_GRACE: Duration = Duration::from_secs(10);

/// How long a child gets to exit after its stdout closed, before we kill it.
const EXIT_GRACE: Duration = Duration::from_secs(5);

/// Budget for the short-lived catalog probe child.
const PROBE_BUDGET: Duration = Duration::from_secs(20);

/// Where the loop's own JSON-RPC ids start.
///
/// Well clear of the handshake's ids (which [`StdioChild::send_request`] mints
/// from 1) so a late handshake response can never be mistaken for a turn
/// result, and clear of the server's own request ids (which start at 0) so a
/// log is readable at a glance.
const REQUEST_ID_BASE: u64 = 1_000;

/// The app-server subcommand. Bare `codex` is the interactive TUI.
const APP_SERVER_ARGS: [&str; 1] = ["app-server"];

// ─────────────────────────────────────────────────────────────────────────────
// Launch
// ─────────────────────────────────────────────────────────────────────────────

/// Build the launch spec for a Codex session.
///
/// `program` is separate so the end-to-end test can point the same argv and the
/// same loop at a fake CLI. On `env_remove`: a dev build started from inside a
/// Claude Code session inherits that session's `CLAUDE*` variables; handing
/// them to a spawned agent makes it think it is running inside another agent's
/// session. `CODEX*` is scrubbed for the same reason in the other direction —
/// a dev build launched from a Codex session would otherwise hand the child its
/// parent's thread state.
pub fn codex_launch(program: String, cwd: PathBuf) -> StdioLaunch {
    StdioLaunch {
        program,
        args: APP_SERVER_ARGS.iter().map(|a| (*a).to_owned()).collect(),
        env: vec![("PATH".to_string(), paths::child_path())],
        env_remove: inherited_agent_env(),
        cwd,
    }
}

/// Names of the inherited variables that must not reach a spawned `codex`.
///
/// Read from the live environment rather than hard-coded, so a variable a
/// future CLI release adds is scrubbed too.
fn inherited_agent_env() -> Vec<String> {
    let mut names: Vec<String> = std::env::vars_os()
        .filter_map(|(key, _)| key.into_string().ok())
        .filter(|key| key.starts_with("CLAUDE") || key.starts_with("CODEX"))
        .collect();
    names.push("HQ_SESSION_ID".to_string());
    names.sort();
    names.dedup();
    names
}

/// Where the `codex` binary lives.
///
/// Prefer the desktop-managed runtime, which updates with Codex desktop. An
/// independently installed PATH CLI can lag behind and expose an older model
/// catalog. Session execution and discovery must use the same runtime.
pub fn codex_program() -> String {
    // Through the launch allowlist even though the name is a literal here:
    // the allowlist is the one place a tool name becomes a program to run, and
    // a second spelling of that rule is a second place to get it wrong.
    let binary = crate::commands::launch::cli_binary_for("codex").unwrap_or("codex");
    select_codex_program(crate::commands::launch::bundled_codex_bin(), || {
        paths::resolve_bin(binary)
    })
}

fn select_codex_program(bundled: Option<PathBuf>, fallback: impl FnOnce() -> String) -> String {
    bundled
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(fallback)
}

/// Spawn the real `codex app-server`.
pub async fn spawn_codex(cwd: PathBuf) -> Result<StdioChild, String> {
    let launch = codex_launch(codex_program(), cwd);
    log(
        LOG_TAG,
        &format!(
            "spawn codex program={} args={:?}",
            launch.program, launch.args
        ),
    );
    StdioChild::spawn(&launch)
        .await
        .map_err(|e| format!("Could not start Codex: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Handshake
// ─────────────────────────────────────────────────────────────────────────────

/// What the handshake established, and what the driver needs to keep.
#[derive(Debug, Clone)]
pub struct CodexHandshake {
    /// Codex's own thread id. This is the resume handle — NOT our session id,
    /// which stays the registry key.
    pub thread_id: String,
    pub model: String,
    pub effort: Option<String>,
    pub commands: Vec<SlashCommand>,
}

/// `initialize` → `initialized` → `thread/start` (or `thread/resume`).
///
/// A resume that the server refuses falls back to a fresh thread: the user
/// asked for a session, and refusing to give them one because a previous
/// thread went missing would be the wrong trade.
pub async fn handshake(
    child: &mut StdioChild,
    spec: &SessionSpec,
) -> Result<CodexHandshake, String> {
    let (approval_policy, sandbox) = policy_for(spec.permission_mode);

    child
        .send_request("initialize", initialize_params(env!("CARGO_PKG_VERSION")))
        .await
        .map_err(|e| format!("Codex did not answer the handshake: {e}"))?;
    // `initialized` is a NOTIFICATION. Sending it as a request wedges us.
    child
        .send_notification("initialized", json!({}))
        .await
        .map_err(|e| format!("Could not complete the Codex handshake: {e}"))?;

    let model = spec.model.as_deref();
    let mut started = None;
    if let Some(resume) = spec
        .resume
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
    {
        let params = thread_resume_params(resume, &spec.cwd, approval_policy, sandbox, model);
        match child.send_request("thread/resume", params).await {
            Ok(result) => started = Some(parse_thread_started(&result)),
            Err(e) => log(
                LOG_TAG,
                &format!("codex resume of {resume} refused ({e}) — starting a fresh thread"),
            ),
        }
    }

    let started = match started.filter(|s| !s.thread_id.is_empty()) {
        Some(started) => started,
        None => {
            let params = thread_start_params(&spec.cwd, approval_policy, sandbox, model);
            let result = child
                .send_request("thread/start", params)
                .await
                .map_err(|e| format!("Codex could not start a thread: {e}"))?;
            parse_thread_started(&result)
        }
    };
    if started.thread_id.is_empty() {
        return Err("Codex started a thread without an id.".into());
    }

    Ok(CodexHandshake {
        thread_id: started.thread_id,
        model: started.model,
        effort: started.reasoning_effort,
        // Autocomplete is supplied independently by probe_command_catalog and
        // merged by SessionsPage. Re-reading skills here scans the provider's
        // filesystem again and delays every first send (3.1s in a live trace).
        commands: Vec::new(),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// The session loop
// ─────────────────────────────────────────────────────────────────────────────

/// The select's decision, reduced to a value so the child is unborrowed before
/// it is used again.
enum Step {
    Out(Option<Outbound>),
    Frame(Result<Option<Value>, StdioError>),
    InterruptTimedOut,
}

/// Why the loop stopped.
struct Ending {
    error: Option<String>,
    crash_class: bool,
}

/// Everything the loop tracks about turns and outstanding requests.
struct Turns {
    thread_id: String,
    approval_policy: &'static str,
    model: Option<String>,
    effort: Option<String>,
    /// The turn currently running, when one is.
    active: Option<String>,
    next_id: u64,
    /// Ids of `turn/start` requests we are waiting on.
    pending_start: Vec<u64>,
    /// Ids of `turn/steer` requests, with the text to re-queue on rejection.
    pending_steer: HashMap<u64, Value>,
    /// Inputs waiting for the active turn to end.
    queued: VecDeque<Value>,
    /// Our parked-request key → the JSON-RPC id to answer on.
    server_requests: HashMap<String, Value>,
}

impl Turns {
    fn id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}

/// Drive one Codex session until its child is gone.
pub async fn run_session_loop(
    mut child: StdioChild,
    session_id: String,
    spec: SessionSpec,
    handshake: CodexHandshake,
    state: Arc<Mutex<SessionState>>,
    sink: Arc<dyn SessionEventSink>,
    mut outbound: UnboundedReceiver<Outbound>,
) {
    let (approval_policy, _) = policy_for(spec.permission_mode);
    let mut turns = Turns {
        thread_id: handshake.thread_id.clone(),
        approval_policy,
        model: spec.model.clone(),
        effort: spec.effort.clone().or_else(|| handshake.effort.clone()),
        active: None,
        next_id: REQUEST_ID_BASE,
        pending_start: Vec::new(),
        pending_steer: HashMap::new(),
        queued: VecDeque::new(),
        server_requests: HashMap::new(),
    };
    let mut normalizer = CodexNormalizer::new();
    let hard_deadline = Instant::now() + SESSION_HARD_DEADLINE;
    let mut interrupt_deadline: Option<Instant> = None;
    let mut ending = Ending {
        error: None,
        crash_class: false,
    };

    // The handshake already happened; announce it before the first frame so
    // the composer has its model and commands.
    record(
        &session_id,
        &state,
        &sink,
        SessionEvent::Started {
            session_id: handshake.thread_id.clone(),
            tool: SessionTool::Codex,
            model: handshake.model.clone(),
            cwd: spec.cwd.clone(),
            // Codex does not enumerate its tools at handshake time; they show
            // up as the calls they make.
            tools: Vec::new(),
            commands: handshake.commands.clone(),
            permission_mode: Some(approval_policy.to_owned()),
            capabilities: vec!["turn_steer".into(), "turn_interrupt".into()],
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
                let input = input_from_line(&line);
                if let Err(e) = send_or_steer(&mut child, &mut turns, input).await {
                    ending = Ending {
                        error: Some(format!("Could not send to Codex: {e}")),
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
                if let Err(e) = write_response(&mut child, &id, result).await {
                    ending = Ending {
                        error: Some(format!("Could not answer Codex: {e}")),
                        crash_class: e.is_crash_class(),
                    };
                    break;
                }
            }

            // The composer's model / effort pills. Codex takes both per turn,
            // so a change lands on the NEXT `turn/start` — no new thread, no
            // new chat. A change made mid-turn cannot retroactively re-run the
            // turn in flight; it applies to the one after it.
            Step::Out(Some(Outbound::SetTurnOptions(overrides))) => {
                turns.model = overrides.model.clone();
                turns.effort = overrides.effort.clone();
            }

            // The permission pill. The auto-approve half already moved (the
            // command surface updates the registry, which `decide_can_use_tool`
            // reads); this is the CLI's own gate, which is a `turn/start`
            // parameter and therefore also only rebindable per turn.
            Step::Out(Some(Outbound::SetPermissionMode(mode))) => {
                turns.approval_policy = policy_for(mode).0;
            }

            Step::Out(Some(Outbound::Interrupt)) => {
                // Mark BEFORE the request: the turn end that follows is
                // indistinguishable on the wire from a real failure.
                normalizer.mark_interrupted();
                let Some(turn) = turns.active.clone() else {
                    // Nothing running; nothing to stop.
                    continue;
                };
                let id = turns.id();
                let request = request_frame(
                    id,
                    "turn/interrupt",
                    turn_interrupt_params(&turns.thread_id, &turn),
                );
                if let Err(e) = child.write_ndjson(&request).await {
                    ending = Ending {
                        error: Some(format!("Could not interrupt Codex: {e}")),
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
                    error: Some("Codex did not respond to the interrupt.".into()),
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

            // The app server is long-lived: EOF before we asked for it is a
            // crash. After `End` closed stdin it is the normal exit, and the
            // session is already on its way out either way.
            Step::Frame(Ok(None)) => break,

            Step::Frame(Err(e)) => {
                ending = Ending {
                    error: Some(match &e {
                        StdioError::IdleTimeout(_) => "Codex stopped responding during this turn. You can resume it from session history.".into(),
                        other => format!("Codex stopped responding: {other}"),
                    }),
                    crash_class: e.is_crash_class(),
                };
                break;
            }
        }
    }

    finish(child, session_id, state, sink, ending).await;
}

/// A user line becomes a turn's `input` array.
///
/// `agent_session_send` puts the already-built array on the wire as JSON so
/// attachments survive the trip through the string-shaped [`Outbound::Line`].
/// A plain string (anything that is not an array) is treated as the text it
/// looks like, which keeps the channel usable from a test or a future caller.
fn input_from_line(line: &str) -> Value {
    match serde_json::from_str::<Value>(line) {
        Ok(value @ Value::Array(_)) => value,
        _ => user_input(line, &[]),
    }
}

/// Steer the running turn, or start a new one.
async fn send_or_steer(
    child: &mut StdioChild,
    turns: &mut Turns,
    input: Value,
) -> Result<(), StdioError> {
    match turns.active.clone() {
        Some(expected) => {
            let id = turns.id();
            let request = request_frame(
                id,
                "turn/steer",
                turn_steer_params(&turns.thread_id, &expected, input.clone()),
            );
            turns.pending_steer.insert(id, input);
            child.write_ndjson(&request).await
        }
        None => start_turn(child, turns, input).await,
    }
}

async fn start_turn(
    child: &mut StdioChild,
    turns: &mut Turns,
    input: Value,
) -> Result<(), StdioError> {
    let id = turns.id();
    let request = request_frame(
        id,
        "turn/start",
        turn_start_params(
            &turns.thread_id,
            input,
            turns.approval_policy,
            turns.model.as_deref(),
            turns.effort.as_deref(),
        ),
    );
    turns.pending_start.push(id);
    child.write_ndjson(&request).await
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

/// Handle one inbound frame. `Ok(true)` means a turn ended (so a pending
/// interrupt has been answered); `Err` is unrecoverable.
async fn handle_frame(
    child: &mut StdioChild,
    session_id: &str,
    state: &Arc<Mutex<SessionState>>,
    sink: &Arc<dyn SessionEventSink>,
    normalizer: &mut CodexNormalizer,
    turns: &mut Turns,
    msg: &Value,
) -> Result<bool, String> {
    let method = msg.get("method").and_then(Value::as_str);
    let id = msg.get("id");

    // A response to one of OUR requests: no `method`, an `id` we minted.
    if method.is_none() {
        if let Some(id) = id.and_then(Value::as_u64) {
            handle_response(child, turns, id, msg)
                .await
                .map_err(|e| format!("Could not continue the Codex turn: {e}"))?;
        }
        return Ok(false);
    }
    let method = method.unwrap_or_default();

    // A server→client request. Record where to answer it BEFORE the events
    // are recorded, so a reply that arrives on the very next tick lands.
    if let Some(id) = id {
        let key = request_key(id);
        let events = normalizer.normalize(msg);
        if events.is_empty() {
            // Never leave a request unanswered: the app server blocks on it.
            let _ = child
                .write_ndjson(&json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("unsupported method: {method}") },
                }))
                .await;
            return Ok(false);
        }
        turns.server_requests.insert(key, id.clone());
        for event in events {
            if !handle_event(child, session_id, state, sink, turns, event).await {
                return Err("Lost the connection to Codex.".into());
            }
        }
        return Ok(false);
    }

    // A notification. Turn bookkeeping first — the loop needs the turn id
    // whether or not the notification produces any transcript.
    let params = msg.get("params").unwrap_or(&Value::Null);
    let mut turn_ended = false;
    match method {
        "turn/started" => {
            if let Some(turn) = params
                .get("turn")
                .and_then(|t| t.get("id"))
                .and_then(Value::as_str)
            {
                turns.active = Some(turn.to_owned());
            }
        }
        "turn/completed" | "turn/failed" | "turn/aborted" => {
            turns.active = None;
            turn_ended = true;
        }
        _ => {}
    }

    for event in normalizer.normalize(msg) {
        if !handle_event(child, session_id, state, sink, turns, event).await {
            return Err("Lost the connection to Codex.".into());
        }
    }

    // A steer that lost its race is delivered now, as its own turn.
    if turn_ended {
        if let Some(input) = turns.queued.pop_front() {
            start_turn(child, turns, input)
                .await
                .map_err(|e| format!("Could not deliver the queued message to Codex: {e}"))?;
        }
    }
    Ok(turn_ended)
}

/// Pair a response with the request that asked for it.
async fn handle_response(
    child: &mut StdioChild,
    turns: &mut Turns,
    id: u64,
    msg: &Value,
) -> Result<(), StdioError> {
    if let Some(position) = turns.pending_start.iter().position(|p| *p == id) {
        turns.pending_start.remove(position);
        if let Some(result) = msg.get("result") {
            if let Some(turn) = parse_turn_started(result) {
                turns.active = Some(turn);
            }
        }
        return Ok(());
    }

    let Some(input) = turns.pending_steer.remove(&id) else {
        return Ok(());
    };
    if msg.get("error").is_none() {
        return Ok(());
    }
    // A rejected steer is a lost race, not bad input: if a turn is still
    // running, wait for it; otherwise send it now.
    if turns.active.is_some() {
        turns.queued.push_back(input);
        Ok(())
    } else {
        start_turn(child, turns, input).await
    }
}

/// Record one normalized event and emit it. Returns `false` only when an
/// auto-approve reply could not be written — i.e. the session is unrecoverable.
///
/// Policy runs BEFORE the event is recorded: a tool the user already allowed
/// for this session must leave no trace of a prompt that never happened.
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
            if let Err(e) = write_response(child, &id, approval_reply(true)).await {
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

/// Record an event the driver itself synthesized (the handshake, errors, exit).
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

/// Record the terminal events and release the child.
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

/// Ask a throwaway `codex app-server` for its skills and models.
///
/// A short-lived probe rather than an in-session round trip, for the same
/// reason as the Claude one: the catalog renders the composer, which happens
/// before any session exists.
pub async fn probe_command_catalog(cwd: PathBuf) -> Result<CommandCatalog, String> {
    let mut child = spawn_codex(cwd).await?;
    let outcome = tokio::time::timeout(PROBE_BUDGET, probe_inner(&mut child)).await;
    child.shutdown_with_reap(REAP_TIMEOUT).await;
    match outcome {
        Ok(result) => result,
        Err(_) => Err("Codex did not answer the command probe in time.".into()),
    }
}

async fn probe_inner(child: &mut StdioChild) -> Result<CommandCatalog, String> {
    child
        .send_request("initialize", initialize_params(env!("CARGO_PKG_VERSION")))
        .await
        .map_err(|e| format!("Could not ask Codex for its commands: {e}"))?;
    child
        .send_notification("initialized", json!({}))
        .await
        .map_err(|e| format!("Could not ask Codex for its commands: {e}"))?;

    // Fetch models first: optional skill discovery can stall on workspace
    // integrations and must not discard an otherwise usable live model list.
    let models = probe_models(child).await?;
    let commands = match tokio::time::timeout(
        Duration::from_secs(3),
        child.send_request("skills/list", json!({})),
    )
    .await
    {
        Ok(Ok(result)) => parse_skills_list(&result),
        _ => Vec::new(),
    };
    Ok(CommandCatalog { commands, models })
}

async fn probe_models(child: &mut StdioChild) -> Result<Vec<Value>, String> {
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen = std::collections::HashSet::new();
    loop {
        let mut params = json!({});
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        let result = child
            .send_request("model/list", params)
            .await
            .map_err(|e| format!("Could not load Codex models: {e}"))?;
        for model in parse_model_list(&result) {
            if !models
                .iter()
                .any(|old: &Value| old["value"] == model["value"])
            {
                models.push(model);
            }
        }
        cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|cursor| !cursor.is_empty())
            .map(str::to_owned);
        let Some(next) = &cursor else { break };
        if !seen.insert(next.clone()) || seen.len() > 100 {
            return Err("Codex returned an invalid model pagination cursor.".into());
        }
    }
    if models.is_empty() {
        return Err("Codex returned no available models. Check its sign-in and retry.".into());
    }
    Ok(models)
}

// ─────────────────────────────────────────────────────────────────────────────
// Login probe
// ─────────────────────────────────────────────────────────────────────────────

pub(super) fn login_status_succeeded(success: bool, stdout: &[u8], stderr: &[u8]) -> bool {
    success
        && [stdout, stderr].iter().any(|stream| {
            String::from_utf8_lossy(stream).lines().any(|line| {
                let line = line.trim();
                line == "Logged in" || line.starts_with("Logged in using ")
            })
        })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_runtime_prefers_desktop_over_stale_path_cli() {
        let bundled = PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex");
        assert_eq!(
            select_codex_program(Some(bundled.clone()), || panic!("PATH must not win")),
            bundled.to_string_lossy()
        );
        assert_eq!(
            select_codex_program(None, || "/usr/local/bin/codex".into()),
            "/usr/local/bin/codex"
        );
    }

    #[tokio::test]
    async fn catalog_loads_all_model_pages_before_optional_skills() {
        let dir = tempfile::tempdir().unwrap();
        let replies = dir.path().join("replies.jsonl");
        let script = r#"
while (!closed || queue.length) {
  const request = await take();
  if (request.method === "initialize") respond(request, {});
  else if (request.method === "model/list") {
    respond(request, request.params?.cursor === "page2"
      ? {data:[{id:"future-model"}],nextCursor:null}
      : {data:[{id:"existing-model"}],nextCursor:"page2"});
  } else if (request.method === "skills/list") respond(request, {data:[]});
}
"#;
        let program = install_fake(dir.path(), &replies, script);
        let mut child = StdioChild::spawn(&fake_launch(program, dir.path().to_path_buf()))
            .await
            .unwrap();
        let result = tokio::time::timeout(Duration::from_secs(5), probe_inner(&mut child))
            .await
            .unwrap()
            .unwrap();
        child.shutdown_with_reap(REAP_TIMEOUT).await;
        assert_eq!(
            result
                .models
                .iter()
                .map(|m| m["value"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["existing-model", "future-model"]
        );
        let sent = std::fs::read_to_string(replies).unwrap();
        assert!(sent.find("model/list").unwrap() < sent.find("skills/list").unwrap());
        assert!(sent.contains("\"cursor\":\"page2\""));
    }
    #[test]
    fn login_status_accepts_both_streams_but_requires_success() {
        assert!(login_status_succeeded(
            true,
            b"",
            b"Logged in using ChatGPT\n"
        ));
        assert!(login_status_succeeded(
            true,
            b"Logged in using an API key\n",
            b""
        ));
        assert!(!login_status_succeeded(
            false,
            b"",
            b"Logged in using ChatGPT\n"
        ));
        assert!(!login_status_succeeded(true, b"", b"Not logged in\n"));
        assert!(!login_status_succeeded(true, b"", b""));
    }
    use hq_desktop_core::agent_session::registry::{LiveSession, NeedsYou, PhaseChange};
    use hq_desktop_core::agent_session::types::{
        DoneStatus, PermissionMode, SessionPhase, SessionTool, TurnOverrides,
    };
    use tokio::sync::mpsc;

    /// A sink that records everything, so a test can assert on the exact
    /// stream the frontend would receive.
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
        fn phases(&self) -> Vec<SessionPhase> {
            self.phases.lock().unwrap().iter().map(|c| c.to).collect()
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

    fn spec(mode: PermissionMode) -> SessionSpec {
        SessionSpec {
            session_id: "sess-cx".into(),
            title: None,
            tool: SessionTool::Codex,
            cwd: "/hq".into(),
            company: Some("indigo".into()),
            project: None,
            model: None,
            effort: None,
            resume: None,
            permission_mode: mode,
        }
    }

    /// A fake `codex app-server` that replays the frames the spike recorded
    /// against the real CLI (codex-cli 0.144.1): the initialize/thread/start
    /// handshake, a turn with a streamed delta and a command execution, an
    /// approval request it BLOCKS on until we answer, then the completion.
    ///
    /// Every line it reads is appended to `$HQ_FAKE_REPLIES`, so the test can
    /// assert on the exact JSON-RPC bytes the driver put on the wire.
    const FAKE_CODEX: &str = r#"
await initialize({"userAgent":"fake/0.144.1","codexHome":"/tmp/codex","platformFamily":"unix","platformOs":"macos"});
const start = await take();
respond(start, {thread:{id:"th-1",sessionId:"th-1",cwd:"/hq"},model:"gpt-5.6-sol",reasoningEffort:"medium",approvalPolicy:"on-request"});
emit({"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"th-1"}}});
// ── one turn
const turn = await take();
respond(turn, {turn:{id:"tu-1",status:"inProgress"}});
emit({"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"th-1","turn":{"id":"tu-1","status":"inProgress"}}});
emit({"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"th-1","turnId":"tu-1","itemId":"m1","delta":"Writing the file."}});
emit({"jsonrpc":"2.0","method":"item/started","params":{"threadId":"th-1","turnId":"tu-1","item":{"type":"commandExecution","id":"exec-1","command":"/bin/zsh -lc 'echo hi > /tmp/hello.txt'","cwd":"/hq","status":"inProgress"}}});
emit({"jsonrpc":"2.0","id":0,"method":"item/commandExecution/requestApproval","params":{"threadId":"th-1","turnId":"tu-1","itemId":"exec-1","reason":"Allow writing outside the sandbox?","command":"/bin/zsh -lc 'echo hi > /tmp/hello.txt'","cwd":"/hq","availableDecisions":["accept","cancel"]}});
const reply = await take();
const exitcode = reply.result?.decision === "accept" ? 0 : 1;
emit({"jsonrpc":"2.0","method":"serverRequest/resolved","params":{"threadId":"th-1","requestId":0}});
emit({jsonrpc:"2.0",method:"item/completed",params:{threadId:"th-1",turnId:"tu-1",item:{type:"commandExecution",id:"exec-1",command:"echo hi",status:"completed",aggregatedOutput:"",exitCode:exitcode}}});
emit({"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"th-1","turnId":"tu-1","item":{"type":"agentMessage","id":"m1","text":"Wrote the file.","phase":"final_answer"}}});
emit({"jsonrpc":"2.0","method":"thread/tokenUsage/updated","params":{"threadId":"th-1","turnId":"tu-1","tokenUsage":{"total":{"inputTokens":99,"outputTokens":99},"last":{"inputTokens":12,"outputTokens":34}}}});
emit({"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"th-1","turn":{"id":"tu-1","status":"completed","error":null}}});
await drain();
"#;

    /// A fake that reproduces the SHAPE of a real first Codex turn: the
    /// bookkeeping burst (`thread/started`, `thread/settings/updated`,
    /// `thread/status/changed`, five `mcpServer/startupStatus/updated`), every
    /// HQ hook pair, and Codex echoing the user's own message back — all of it
    /// before a single token of the answer. That is 30–50s on the real CLI and
    /// it is exactly the window the session used to spend saying "Idle".
    ///
    /// It also blocks until a second line arrives, so the test can prove the
    /// pill overrides ride the `turn/start` that follows.
    const FAKE_CODEX_SLOW_FIRST_TURN: &str = r#"
await initialize({"codexHome":"/tmp/codex"});
const start = await take();
respond(start, {thread:{id:"th-5"},model:"gpt-5.6-sol",reasoningEffort:"medium"});
const turn = await take();
respond(turn, {turn:{id:"tu-5",status:"inProgress"}});
emit({"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"th-5"}}});
for (let i = 0; i < 5; i++) { emit({"jsonrpc":"2.0","method":"mcpServer/startupStatus/updated","params":{"server":"hq"}}); }
emit({"jsonrpc":"2.0","method":"thread/settings/updated","params":{"threadId":"th-5"}});
emit({"jsonrpc":"2.0","method":"thread/status/changed","params":{"threadId":"th-5","status":"running"}});
emit({"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"th-5","turn":{"id":"tu-5","status":"inProgress"}}});
emit({"jsonrpc":"2.0","method":"warning","params":{"message":"a warning is not a turn ending"}});
for (let i = 0; i < 5; i++) {
  emit({"jsonrpc":"2.0","method":"hook/started","params":{"threadId":"th-5","hook":{"name":"hq"}}});
  emit({"jsonrpc":"2.0","method":"hook/completed","params":{"threadId":"th-5","hook":{"name":"hq"}}});
}
emit({"jsonrpc":"2.0","method":"item/started","params":{"threadId":"th-5","turnId":"tu-5","item":{"type":"userMessage","id":"u1","content":[{"type":"text","text":"hello"}]}}});
emit({"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"th-5","turnId":"tu-5","item":{"type":"userMessage","id":"u1","content":[{"type":"text","text":"hello"}]}}});
emit({"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"threadId":"th-5","turnId":"tu-5","itemId":"m1","delta":"Hi."}});
await sleep(1000);
emit({"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"th-5","turnId":"tu-5","item":{"type":"agentMessage","id":"m1","text":"Hi.","phase":"final_answer"}}});
emit({"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"th-5","turn":{"id":"tu-5","status":"completed","error":null}}});
const second = await take();
respond(second, {turn:{id:"tu-6"}});
emit({"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"th-5","turn":{"id":"tu-6"}}});
emit({"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"th-5","turn":{"id":"tu-6","status":"completed","error":null}}});
await drain();
"#;

    /// A fake that starts a long turn, honours `turn/interrupt` with
    /// `turn/aborted`, and stays alive — the interrupt path end to end.
    const FAKE_CODEX_INTERRUPT: &str = r#"
await initialize({"codexHome":"/tmp/codex"});
const start = await take();
respond(start, {thread:{id:"th-2"},model:"gpt-5.6-sol"});
const turn = await take();
respond(turn, {turn:{id:"tu-2"}});
emit({"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"th-2","turn":{"id":"tu-2"}}});
for (let i = 1; i <= 4; i++) {
  emit({jsonrpc:"2.0",method:"item/agentMessage/delta",params:{threadId:"th-2",turnId:"tu-2",itemId:"m1",delta:`tick ${i} `}});
  await sleep(200);
}
respond(await take(), {});
emit({"jsonrpc":"2.0","method":"turn/aborted","params":{"threadId":"th-2","turnId":"tu-2"}});
await drain();
"#;

    /// A fake that REJECTS `turn/steer` (the "you lost the race" case), then
    /// ends the turn — the driver must re-deliver the text as its own turn.
    const FAKE_CODEX_STEER_REJECT: &str = r#"
await initialize({"codexHome":"/tmp/codex"});
const start = await take();
respond(start, {thread:{id:"th-3"},model:"gpt-5.6-sol"});
const first = await take();
respond(first, {turn:{id:"tu-3"}});
emit({"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"th-3","turn":{"id":"tu-3"}}});
const steer = await take();
if (steer.method === "turn/steer") {
  emit({jsonrpc:"2.0",id:steer.id,error:{code:-32602,message:"expectedTurnId no longer active"}});
} else {
  emit({"jsonrpc":"2.0","method":"turn/failed","params":{"turn":{"id":"tu-3","error":{"message":"expected turn/steer"}}}});
  await drain();
  return;
}
emit({"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"th-3","turn":{"id":"tu-3","status":"completed","error":null}}});
const second = await take();
respond(second, {turn:{id:"tu-4"}});
emit({"jsonrpc":"2.0","method":"turn/started","params":{"threadId":"th-3","turn":{"id":"tu-4"}}});
emit({"jsonrpc":"2.0","method":"item/completed","params":{"threadId":"th-3","turnId":"tu-4","item":{"type":"agentMessage","id":"m2","text":"Got both.","phase":"final_answer"}}});
emit({"jsonrpc":"2.0","method":"turn/completed","params":{"threadId":"th-3","turn":{"id":"tu-4","status":"completed","error":null}}});
await drain();
"#;

    /// Node executes the fixture on every host; the production provider argv
    /// remains after the script path, without shell parsing or global env edits.
    fn install_fake(dir: &std::path::Path, replies: &std::path::Path, script: &str) -> String {
        let path = dir.join("fake-codex.cjs");
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
async function initialize(result) { respond(await take(), result); await take(); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function drain() { while (!closed || queue.length) await take(); }
"#;
        std::fs::write(&path, format!(
            "const replies = {};\n{runtime}\n(async () => {{\n{script}\n}})().catch(error => {{ console.error(error); process.exit(1); }});\n",
            serde_json::to_string(&replies.to_string_lossy()).unwrap(),
        )).expect("write fake");
        path.to_string_lossy().into_owned()
    }

    fn fake_launch(script: String, cwd: PathBuf) -> StdioLaunch {
        let mut launch = codex_launch(paths::resolve_bin("node"), cwd);
        assert_eq!(launch.args, vec!["app-server".to_string()]);
        launch.args.insert(0, script);
        launch
    }

    struct Harness {
        state: Arc<Mutex<SessionState>>,
        sink: Arc<RecordingSink>,
        tx: mpsc::UnboundedSender<Outbound>,
        join: tokio::task::JoinHandle<()>,
        _dir: tempfile::TempDir,
        replies: PathBuf,
        pid: Option<u32>,
    }

    impl Harness {
        /// Every line the fake read back from us, parsed.
        fn sent(&self) -> Vec<Value> {
            std::fs::read_to_string(&self.replies)
                .unwrap_or_default()
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| serde_json::from_str(l).expect("the driver writes valid JSON"))
                .collect()
        }
    }

    async fn start_with(mode: PermissionMode, script: &str) -> Harness {
        let dir = tempfile::tempdir().expect("tempdir");
        let replies = dir.path().join("replies.jsonl");
        let program = install_fake(dir.path(), &replies, script);

        let spec = spec(mode);
        let launch = fake_launch(program, dir.path().to_path_buf());
        // The fake is driven with the real argv, so a regression that stopped
        // asking for the app server would show up here too.
        assert_eq!(&launch.args[1..], &["app-server".to_string()]);

        let mut child = StdioChild::spawn(&launch).await.expect("spawn fake");
        let pid = child.pid();
        let handshake = handshake(&mut child, &spec).await.expect("handshake");
        assert_eq!(handshake.model, "gpt-5.6-sol");

        let state = Arc::new(Mutex::new(SessionState::default()));
        state
            .lock()
            .await
            .registry
            .insert(LiveSession::new(spec.clone(), now_iso()))
            .expect("insert");

        let (tx, rx) = mpsc::unbounded_channel();
        state.lock().await.set_channel(&spec.session_id, tx.clone());

        let sink = Arc::new(RecordingSink::default());
        let join = tokio::spawn(run_session_loop(
            child,
            spec.session_id.clone(),
            spec.clone(),
            handshake,
            state.clone(),
            Arc::new(sink.clone()) as Arc<dyn SessionEventSink>,
            rx,
        ));

        Harness {
            state,
            sink,
            tx,
            join,
            _dir: dir,
            replies,
            pid,
        }
    }

    #[tokio::test]
    async fn handshake_ready_without_waiting_for_optional_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let replies = dir.path().join("replies.jsonl");
        // Answer only the required initialization and thread creation frames.
        // A catalog read would stall forever, just as an unavailable skill
        // filesystem can in the real provider. It must not gate first send.
        let script = FAKE_CODEX.split("// ── one turn").next().unwrap().to_owned()
            + "\nawait drain();\n";
        let program = install_fake(dir.path(), &replies, &script);
        let mut child = StdioChild::spawn(&fake_launch(program, dir.path().into()))
            .await
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            handshake(&mut child, &spec(PermissionMode::Prompt)),
        )
        .await;
        child.shutdown_with_reap(REAP_TIMEOUT).await;
        assert!(result.is_ok(), "optional catalog blocked session readiness");
        assert_eq!(result.unwrap().unwrap().thread_id, "th-1");
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

    #[tokio::test]
    async fn a_prompted_session_parks_a_codex_approval_and_resumes_when_accepted() {
        let h = start_with(PermissionMode::Prompt, FAKE_CODEX).await;

        // Started lands from the handshake, before any frame is read.
        until("the handshake event", || !h.sink.events().is_empty()).await;
        assert!(
            matches!(&h.sink.events()[0].1, SessionEvent::Started { session_id, tool, model, commands, .. }
                if session_id == "th-1"
                    && *tool == SessionTool::Codex
                    && model == "gpt-5.6-sol"
                    && commands.is_empty()),
            "first event should be Started: {:?}",
            h.sink.events()[0].1
        );

        h.tx.send(Outbound::Line("write a file".into()))
            .expect("send turn");

        until("the approval request", || !h.sink.needs().is_empty()).await;

        let events = h.sink.events();
        assert!(
            events.iter().any(|(_, e)| matches!(
                e,
                SessionEvent::TextDelta { text, .. } if text == "Writing the file."
            )),
            "the streamed text reached the sink: {events:?}"
        );
        assert!(
            events.iter().any(|(_, e)| matches!(
                e,
                SessionEvent::ToolCall { id, name, .. } if id == "exec-1" && name == "Bash"
            )),
            "the command call reached the sink: {events:?}"
        );

        let needs = h.sink.needs();
        assert_eq!(needs.len(), 1);
        assert_eq!(needs[0].reason, "permission");
        assert_eq!(needs[0].summary, "Bash");
        assert_eq!(
            needs[0].request_id, "0",
            "the request is parked under the JSON-RPC id the reply must use"
        );
        {
            let guard = h.state.lock().await;
            let session = guard.registry.get("sess-cx").expect("session");
            assert_eq!(session.phase, SessionPhase::NeedsYou);
            assert_eq!(session.pending.len(), 1);
        }

        // Accept it, exactly as `agent_session_respond_permission` would.
        h.tx.send(Outbound::Reply {
            request_id: "0".into(),
            result: approval_reply(true),
        })
        .expect("send accept");
        {
            let mut guard = h.state.lock().await;
            guard
                .registry
                .get_mut("sess-cx")
                .unwrap()
                .on_response_sent("0", now_iso());
        }

        until("the turn to finish", || {
            h.sink
                .events()
                .iter()
                .any(|(_, e)| matches!(e, SessionEvent::TurnDone { .. }))
        })
        .await;

        let events = h.sink.events();
        assert!(
            events.iter().any(|(_, e)| matches!(
                e,
                SessionEvent::ToolResult { id, is_error: false, .. } if id == "exec-1"
            )),
            "the command ran and reported back: {events:?}"
        );
        assert!(
            events.iter().any(|(_, e)| matches!(
                e,
                SessionEvent::AssistantMessage { text, .. } if text == "Wrote the file."
            )),
            "the final answer landed: {events:?}"
        );
        assert!(
            events.iter().any(|(_, e)| matches!(
                e,
                SessionEvent::Usage {
                    input_tokens: 12,
                    output_tokens: 34,
                    ..
                }
            )),
            "usage came from `last`, not the running total: {events:?}"
        );
        assert!(events.iter().any(|(_, e)| matches!(
            e,
            SessionEvent::TurnDone {
                status: DoneStatus::Success,
                ..
            }
        )));
        assert_eq!(
            h.state.lock().await.registry.get("sess-cx").unwrap().phase,
            SessionPhase::Idle
        );

        // ── the exact bytes we put on the wire ───────────────────────────────
        let sent = h.sent();
        assert_eq!(sent[0]["method"], "initialize");
        assert_eq!(sent[0]["params"]["capabilities"]["experimentalApi"], true);
        assert_eq!(sent[1]["method"], "initialized");
        assert!(
            sent[1].get("id").is_none(),
            "`initialized` must be a notification: {}",
            sent[1]
        );
        assert_eq!(sent[2]["method"], "thread/start");
        assert_eq!(sent[2]["params"]["approvalPolicy"], "on-request");
        assert_eq!(sent[2]["params"]["sandbox"], "workspace-write");
        assert_eq!(sent[3]["method"], "turn/start");
        assert!(!sent.iter().any(|frame| frame["method"] == "skills/list"));

        let turn = sent
            .iter()
            .find(|m| m["method"] == "turn/start")
            .expect("turn/start");
        assert_eq!(turn["params"]["threadId"], "th-1");
        assert_eq!(turn["params"]["input"][0]["text"], "write a file");
        assert_eq!(turn["params"]["summary"], "auto");

        let reply = sent
            .iter()
            .find(|m| m.get("method").is_none() && m.get("result").is_some())
            .expect("the approval reply");
        assert_eq!(reply["jsonrpc"], "2.0");
        assert_eq!(
            reply["id"], 0,
            "the reply must land on the request's own id"
        );
        assert_eq!(reply["result"]["decision"], "accept");

        h.tx.send(Outbound::End).expect("send end");
        h.join.await.expect("loop finished");

        let guard = h.state.lock().await;
        let session = guard
            .registry
            .get("sess-cx")
            .expect("session survives for replay");
        assert_eq!(session.phase, SessionPhase::Ended);
        assert!(session.pending.is_empty());
        assert!(!guard.has_channel("sess-cx"));
    }

    #[tokio::test]
    async fn a_codex_session_stays_working_from_the_send_until_the_turn_ends() {
        let h = start_with(PermissionMode::Prompt, FAKE_CODEX_SLOW_FIRST_TURN).await;

        // The handshake announcement lands first, exactly as it does in the
        // app — which is what made this a race worth pinning.
        until("the handshake event", || !h.sink.events().is_empty()).await;
        assert_eq!(
            h.state.lock().await.registry.get("sess-cx").unwrap().phase,
            SessionPhase::Idle
        );

        // Send through the REAL command path, so `on_user_send` runs where it
        // runs in production rather than being restated here.
        {
            let mut guard = h.state.lock().await;
            super::super::record_and_queue_user_turn(
                &mut guard,
                &h.sink,
                "sess-cx",
                "hello",
                user_input("hello", &[]).to_string(),
                0,
            )
            .expect("queue the turn");
        }
        assert_eq!(
            h.state.lock().await.registry.get("sess-cx").unwrap().phase,
            SessionPhase::Working,
            "the composer must show work the instant Enter is pressed"
        );

        // Everything the real CLI streams before it says anything: the thread
        // bookkeeping, five MCP startup notices, ten HQ hook frames, and Codex
        // echoing our own message back. None of it is a turn ending.
        until("the first token", || {
            h.sink
                .events()
                .iter()
                .any(|(_, e)| matches!(e, SessionEvent::TextDelta { .. }))
        })
        .await;
        assert_eq!(
            h.state.lock().await.registry.get("sess-cx").unwrap().phase,
            SessionPhase::Working,
            "phase must not have gone Idle while the model was thinking"
        );
        assert_eq!(
            h.sink.phases(),
            vec![SessionPhase::Idle, SessionPhase::Working],
            "no Idle edge between the send and the turn's own ending"
        );
        // The bookkeeping produced no transcript at all — only the answer did.
        assert_eq!(
            h.sink
                .events()
                .iter()
                .filter(|(_, e)| matches!(e, SessionEvent::UserMessage { .. }))
                .count(),
            1,
            "Codex echoing the turn back must not double the prompt"
        );

        until("the turn to finish", || {
            h.sink
                .events()
                .iter()
                .any(|(_, e)| matches!(e, SessionEvent::TurnDone { .. }))
        })
        .await;
        assert_eq!(
            h.state.lock().await.registry.get("sess-cx").unwrap().phase,
            SessionPhase::Idle,
            "only `turn/completed` returns the session to Idle"
        );
        assert_eq!(
            h.sink.phases(),
            vec![
                SessionPhase::Idle,
                SessionPhase::Working,
                SessionPhase::Idle
            ],
            "one working span, with no flicker in the middle of it"
        );

        // ── the pills move the SAME session ──────────────────────────────────
        h.tx.send(Outbound::SetTurnOptions(TurnOverrides {
            model: Some("gpt-5.6-codex".into()),
            effort: Some("xhigh".into()),
        }))
        .expect("send overrides");
        h.tx.send(Outbound::Line(user_input("again", &[]).to_string()))
            .expect("send turn");

        until("the second turn/start", || {
            h.sent()
                .iter()
                .filter(|m| m["method"] == "turn/start")
                .count()
                == 2
        })
        .await;
        let starts: Vec<Value> = h
            .sent()
            .into_iter()
            .filter(|m| m["method"] == "turn/start")
            .collect();
        assert!(
            starts[0]["params"].get("model").is_none(),
            "the first turn carried no override: {}",
            starts[0]
        );
        assert_eq!(
            starts[1]["params"]["threadId"], "th-5",
            "same thread, not a fork"
        );
        assert_eq!(starts[1]["params"]["model"], "gpt-5.6-codex");
        assert_eq!(starts[1]["params"]["effort"], "xhigh");

        h.tx.send(Outbound::End).expect("send end");
        h.join.await.expect("loop finished");
    }

    #[tokio::test]
    async fn a_permission_pill_change_rebinds_the_next_turns_approval_policy() {
        let h = start_with(PermissionMode::Prompt, FAKE_CODEX_SLOW_FIRST_TURN).await;
        until("the handshake event", || !h.sink.events().is_empty()).await;

        h.tx.send(Outbound::Line(user_input("hello", &[]).to_string()))
            .expect("send turn");
        until("the turn to finish", || {
            h.sink
                .events()
                .iter()
                .any(|(_, e)| matches!(e, SessionEvent::TurnDone { .. }))
        })
        .await;

        h.tx.send(Outbound::SetPermissionMode(PermissionMode::BypassAll))
            .expect("send mode");
        h.tx.send(Outbound::Line(user_input("again", &[]).to_string()))
            .expect("send turn");

        until("the second turn/start", || {
            h.sent()
                .iter()
                .filter(|m| m["method"] == "turn/start")
                .count()
                == 2
        })
        .await;
        let starts: Vec<Value> = h
            .sent()
            .into_iter()
            .filter(|m| m["method"] == "turn/start")
            .collect();
        assert_eq!(starts[0]["params"]["approvalPolicy"], "on-request");
        assert_eq!(
            starts[1]["params"]["approvalPolicy"], "never",
            "the pill moved the live session rather than starting a new one"
        );

        h.tx.send(Outbound::End).expect("send end");
        h.join.await.expect("loop finished");
    }

    #[tokio::test]
    async fn bypass_mode_auto_approves_and_never_surfaces_a_codex_prompt() {
        let h = start_with(PermissionMode::BypassAll, FAKE_CODEX).await;
        h.tx.send(Outbound::Line("write a file".into()))
            .expect("send turn");

        until("the turn to finish", || {
            h.sink
                .events()
                .iter()
                .any(|(_, e)| matches!(e, SessionEvent::TurnDone { .. }))
        })
        .await;

        let events = h.sink.events();
        assert!(
            !events
                .iter()
                .any(|(_, e)| matches!(e, SessionEvent::PermissionRequest { .. })),
            "bypass must not surface a prompt: {events:?}"
        );
        assert!(h.sink.needs().is_empty(), "and must never need the user");
        assert!(!h.sink.phases().contains(&SessionPhase::NeedsYou));
        assert!(
            events.iter().any(|(_, e)| matches!(
                e,
                SessionEvent::ToolResult { id, is_error: false, .. } if id == "exec-1"
            )),
            "the command still ran — the driver answered on the user's behalf"
        );

        let sent = h.sent();
        let start = sent
            .iter()
            .find(|m| m["method"] == "thread/start")
            .expect("thread/start");
        assert_eq!(start["params"]["approvalPolicy"], "never");
        assert_eq!(start["params"]["sandbox"], "danger-full-access");
        let reply = sent
            .iter()
            .find(|m| m.get("method").is_none() && m.get("result").is_some())
            .expect("the auto-approval");
        assert_eq!(reply["id"], 0);
        assert_eq!(reply["result"]["decision"], "accept");

        h.tx.send(Outbound::End).expect("send end");
        h.join.await.expect("loop finished");
    }

    #[cfg(unix)]
    fn alive(pid: u32) -> bool {
        // SAFETY: `kill(2)` with signal 0 performs the existence check only.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[cfg(unix)]
    async fn until_gone(pid: u32) -> bool {
        for _ in 0..200 {
            if !alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        false
    }

    /// Stopping a streaming turn ends it as *interrupted*, not failed, and the
    /// session comes back Idle ready for the next prompt.
    #[tokio::test]
    async fn interrupting_a_streaming_codex_turn_ends_it_as_interrupted() {
        let h = start_with(PermissionMode::BypassAll, FAKE_CODEX_INTERRUPT).await;
        h.tx.send(Outbound::Line("think for a while".into()))
            .expect("send turn");

        until("the stream to start", || {
            h.sink
                .events()
                .iter()
                .any(|(_, e)| matches!(e, SessionEvent::TextDelta { .. }))
        })
        .await;

        h.tx.send(Outbound::Interrupt).expect("send interrupt");

        until("the turn to finish", || {
            h.sink
                .events()
                .iter()
                .any(|(_, e)| matches!(e, SessionEvent::TurnDone { .. }))
        })
        .await;

        let events = h.sink.events();
        assert!(
            events.iter().any(|(_, e)| matches!(
                e,
                SessionEvent::TurnDone {
                    status: DoneStatus::Interrupted,
                    error: None,
                    ..
                }
            )),
            "an interrupted turn is Interrupted, not Error: {events:?}"
        );
        assert!(
            !events
                .iter()
                .any(|(_, e)| matches!(e, SessionEvent::Error { .. })),
            "and produces no error event: {events:?}"
        );
        assert_eq!(
            h.state.lock().await.registry.get("sess-cx").unwrap().phase,
            SessionPhase::Idle
        );

        let interrupt = h
            .sent()
            .into_iter()
            .find(|m| m["method"] == "turn/interrupt")
            .expect("turn/interrupt");
        assert_eq!(interrupt["params"]["threadId"], "th-2");
        assert_eq!(
            interrupt["params"]["turnId"], "tu-2",
            "the interrupt names the turn it is stopping"
        );

        h.tx.send(Outbound::End).expect("send end");
        h.join.await.expect("loop finished");
        #[cfg(unix)]
        {
            let pid = h.pid.expect("the fake reported a pid");
            assert!(
                until_gone(pid).await,
                "the fake codex (pid {pid}) outlived the session"
            );
        }
    }

    /// A steer the server refuses is the user losing a race with their own
    /// turn, not bad input — the words must be redelivered, not dropped.
    #[tokio::test]
    async fn a_rejected_steer_is_redelivered_as_the_next_turn() {
        let h = start_with(PermissionMode::BypassAll, FAKE_CODEX_STEER_REJECT).await;
        h.tx.send(Outbound::Line("first".into())).expect("send");
        until("the first turn to be running", || {
            h.sent().iter().any(|m| m["method"] == "turn/start")
        })
        .await;

        h.tx.send(Outbound::Line("second".into())).expect("steer");

        until("the answer to both", || {
            h.sink.events().iter().any(|(_, e)| {
                matches!(
                    e,
                    SessionEvent::AssistantMessage { text, .. } if text == "Got both."
                )
            })
        })
        .await;

        let sent = h.sent();
        let steer = sent
            .iter()
            .find(|m| m["method"] == "turn/steer")
            .expect("the second line was steered into the running turn");
        assert_eq!(steer["params"]["expectedTurnId"], "tu-3");
        assert_eq!(steer["params"]["input"][0]["text"], "second");

        let starts: Vec<&Value> = sent
            .iter()
            .filter(|m| m["method"] == "turn/start")
            .collect();
        assert_eq!(starts.len(), 2, "the rejected steer became its own turn");
        assert_eq!(starts[0]["params"]["input"][0]["text"], "first");
        assert_eq!(
            starts[1]["params"]["input"][0]["text"], "second",
            "the words the user typed were not lost: {sent:?}"
        );

        h.tx.send(Outbound::End).expect("send end");
        h.join.await.expect("loop finished");
    }
}
