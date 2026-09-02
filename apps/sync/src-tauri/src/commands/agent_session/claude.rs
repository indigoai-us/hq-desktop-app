//! The Claude driver: one `claude --print --input-format stream-json` child,
//! one task, one live session.
//!
//! # Shape of the thing
//!
//! [`StdioChild`] owns both halves of the child's stdio, and
//! [`StdioChild::next_frame`] takes `&mut self` — so exactly one task may touch
//! it. That task is [`run_session_loop`], and every command that needs to WRITE
//! (`send`, `respond`, `interrupt`, `end`) posts an [`Outbound`] on an mpsc
//! channel the loop selects on alongside the read. No lock is held across a
//! read, so a permission response lands the moment the user clicks it rather
//! than after the next frame.
//!
//! # The `select!` shape is deliberate
//!
//! Both the read future and the outbound handler need `&mut child`, which the
//! borrow checker will not allow inside one `select!`. The loop therefore
//! reduces the select to a plain [`Step`] value and does all child work *after*
//! the select has dropped its futures. Cancelling `next_frame` mid-read is
//! safe: the decode buffer lives in the child's `FramedRead`, not in the
//! future, so a cancelled read loses no bytes.
//!
//! # Auto-allow happens before the UI hears about it
//!
//! A `can_use_tool` request that policy already answers (bypass mode, or a tool
//! the user allowed for the session) is replied to inline and never surfaces as
//! a `PermissionRequest`. The `ToolCall` event already shows the call, so
//! emitting a prompt the user never sees — and a `NeedsYou` phase they never
//! get to resolve — would be a bug, not extra information.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use hq_desktop_core::agent_session::claude_wire::{
    allow_response, build_args, control_response_line, frame_from_value, initialize_request_line,
    interrupt_request_line, parse_can_use_tool, parse_initialize_commands, parse_initialize_models,
    Frame,
};
use hq_desktop_core::agent_session::registry::{
    decide_can_use_tool, AutoDecision, NeedsYou, PhaseChange,
};
use hq_desktop_core::agent_session::types::{SessionEvent, SessionSpec, SlashCommand};
use hq_desktop_core::agent_session::ClaudeNormalizer;
use hq_desktop_core::paths;
use hq_desktop_core::stdio::child::REAP_TIMEOUT;
use hq_desktop_core::stdio::{StdioChild, StdioError, StdioLaunch};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::util::logfile::log;

use super::{now_iso, SessionState};

/// Tauri event carrying one transcript event.
pub const EVENT_SESSION_EVENT: &str = "agent-session:event";
/// Tauri event carrying a phase transition.
pub const EVENT_SESSION_PHASE: &str = "agent-session:phase";
/// Tauri event carrying "this session is blocked on you".
pub const EVENT_SESSION_NEEDS_YOU: &str = "agent-session:needs-you";

const LOG_TAG: &str = "agent-session";

/// Silence budget before we call a session dead. Generous on purpose: a long
/// Bash step or a slow MCP server is silence, and killing a working session is
/// far worse than waiting.
const IDLE_TIMEOUT: Duration = Duration::from_secs(600);

/// Absolute cap on one session's lifetime. Not a real product limit — it exists
/// so `next_frame`'s hard deadline is a finite instant rather than "never".
const SESSION_HARD_DEADLINE: Duration = Duration::from_secs(24 * 60 * 60);

/// How long an interrupt gets to produce a `result` before we stop asking
/// nicely. The spike measured the receipt + `result` pair arriving immediately.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

/// How long a child gets to exit after its stdout closed, before we kill it.
const EXIT_GRACE: Duration = Duration::from_secs(5);

/// Budget for the short-lived `initialize` probe child.
const PROBE_BUDGET: Duration = Duration::from_secs(20);

// ─────────────────────────────────────────────────────────────────────────────
// Event sink
// ─────────────────────────────────────────────────────────────────────────────

/// Where the driver's emissions go.
///
/// A trait rather than a bare `AppHandle` so the end-to-end test can drive the
/// real loop against a real child process and read the real emissions, without
/// standing up a Tauri app. An untested driver is the one thing in this feature
/// that would actually hurt.
pub trait SessionEventSink: Send + Sync + 'static {
    fn emit_event(&self, session_id: &str, seq: u64, event: &SessionEvent);
    fn emit_phase(&self, session_id: &str, change: PhaseChange);
    fn emit_needs_you(&self, session_id: &str, needs: &NeedsYou);
}

/// The production sink: Tauri events on the app handle.
pub struct AppSink(pub AppHandle);

impl SessionEventSink for AppSink {
    fn emit_event(&self, session_id: &str, seq: u64, event: &SessionEvent) {
        let _ = self.0.emit(
            EVENT_SESSION_EVENT,
            serde_json::json!({ "sessionId": session_id, "seq": seq, "event": event }),
        );
    }

    fn emit_phase(&self, session_id: &str, change: PhaseChange) {
        let _ = self.0.emit(
            EVENT_SESSION_PHASE,
            serde_json::json!({
                "sessionId": session_id,
                "from": change.from,
                "to": change.to,
            }),
        );
    }

    fn emit_needs_you(&self, session_id: &str, needs: &NeedsYou) {
        let _ = self.0.emit(
            EVENT_SESSION_NEEDS_YOU,
            serde_json::json!({
                "sessionId": session_id,
                "requestId": needs.request_id,
                "reason": needs.reason,
                "summary": needs.summary,
            }),
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound instructions
// ─────────────────────────────────────────────────────────────────────────────

/// What a command asks the session task to do. Everything that writes to the
/// child goes through here, so the loop stays the single owner of stdin.
#[derive(Debug, Clone, PartialEq)]
pub enum Outbound {
    /// Write one already-built NDJSON line (user turn, control response).
    Line(String),
    /// Mark the normalizer interrupted, then send the interrupt request. The
    /// two must not be reordered: the `result` that answers an interrupt is
    /// indistinguishable on the wire from a real failure, and only the flag
    /// tells them apart.
    Interrupt,
    /// Close stdin and let the child finish and exit on its own.
    End,
    /// Kill the process group now.
    Kill,
}

/// The select's decision, reduced to a value so the child is unborrowed before
/// it is used again.
enum Step {
    Out(Option<Outbound>),
    Frame(Result<Option<Value>, StdioError>),
    InterruptTimedOut,
}

/// Why the loop stopped, for the terminal `Exited` event.
struct Ending {
    error: Option<String>,
    /// True when the child died in a way that should count against the crash
    /// breaker (as opposed to a user-requested end).
    crash_class: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Launch
// ─────────────────────────────────────────────────────────────────────────────

/// Build the launch spec for a Claude session.
///
/// `program` is separate from `spec` so the end-to-end test can point the same
/// argv and the same loop at a fake CLI. Production passes
/// `paths::resolve_bin("claude")`.
///
/// On `env`: [`StdioChild::spawn`] already forces `PATH` to
/// [`paths::child_path`] (a Finder-launched GUI inherits launchd's minimal
/// PATH, which has no `node`), and applies everything else operator-wins — an
/// inherited variable is never overridden. Passing PATH here is therefore
/// belt-and-braces rather than load-bearing.
///
/// On `env_remove`: an inherited variable cannot be cleared through `env` (that
/// list has no value meaning "absent"), which is what [`StdioLaunch::env_remove`]
/// is for. A shipped app launched from Finder has nothing to clear, but a dev
/// build started from inside a Claude Code session — `cargo tauri dev` in an
/// agent's shell — inherits that session's `CLAUDECODE`,
/// `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, and friends. Handing
/// those to the `claude` we spawn makes the child think it is running *inside*
/// another Claude session and quietly changes its behaviour. We therefore scrub
/// every inherited `CLAUDE*` variable plus `HQ_SESSION_ID` at launch time. The
/// list is computed from the live environment rather than hard-coded so a
/// variable the CLI adds in a future release is scrubbed too.
pub fn claude_launch(program: String, spec: &SessionSpec, cwd: PathBuf) -> StdioLaunch {
    StdioLaunch {
        program,
        args: build_args(spec),
        env: vec![("PATH".to_string(), paths::child_path())],
        env_remove: inherited_agent_env(),
        cwd,
    }
}

/// Names of the inherited variables that must not reach a spawned `claude`.
///
/// The `CLAUDE*` half is read from [`std::env::vars_os`] at call time, so it
/// covers whatever the surrounding session actually set rather than a
/// hard-coded guess. Non-UTF-8 names are skipped — they cannot be one of ours,
/// and `Command::env_remove` wants a name we can spell. `HQ_SESSION_ID` is
/// listed unconditionally; removing a variable the parent does not have is a
/// no-op, and an unconditional entry cannot go stale.
fn inherited_agent_env() -> Vec<String> {
    let mut names: Vec<String> = std::env::vars_os()
        .filter_map(|(key, _)| key.into_string().ok())
        .filter(|key| key.starts_with("CLAUDE"))
        .collect();
    names.push("HQ_SESSION_ID".to_string());
    names.sort();
    names.dedup();
    names
}

/// Spawn the real `claude` CLI for `spec`.
pub async fn spawn_claude(spec: &SessionSpec, cwd: PathBuf) -> Result<StdioChild, String> {
    let program = paths::resolve_bin("claude");
    let launch = claude_launch(program, spec, cwd);
    log(
        LOG_TAG,
        &format!(
            "spawn session={} program={} args={:?}",
            spec.session_id, launch.program, launch.args
        ),
    );
    StdioChild::spawn(&launch)
        .await
        .map_err(|e| format!("Could not start Claude: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// The session loop
// ─────────────────────────────────────────────────────────────────────────────

/// Drive one session until its child is gone.
///
/// Owns the child and the normalizer; borrows the registry only for the instant
/// it takes to record an event.
pub async fn run_session_loop(
    mut child: StdioChild,
    session_id: String,
    state: Arc<Mutex<SessionState>>,
    sink: Arc<dyn SessionEventSink>,
    mut outbound: UnboundedReceiver<Outbound>,
) {
    let mut normalizer = ClaudeNormalizer::new();
    let hard_deadline = Instant::now() + SESSION_HARD_DEADLINE;
    let mut interrupt_deadline: Option<Instant> = None;
    let mut ending = Ending {
        error: None,
        crash_class: false,
    };

    loop {
        // `sleep_until` needs an instant even when its arm is disabled; the
        // `if` guard is what actually keeps it from firing.
        let force_at = interrupt_deadline.unwrap_or_else(|| Instant::now() + SESSION_HARD_DEADLINE);

        let step = tokio::select! {
            biased;
            msg = outbound.recv() => Step::Out(msg),
            _ = tokio::time::sleep_until(force_at), if interrupt_deadline.is_some() => {
                Step::InterruptTimedOut
            }
            frame = child.next_frame(IDLE_TIMEOUT, hard_deadline) => Step::Frame(frame),
        };

        match step {
            // Every sender dropped — the session was removed out from under us.
            Step::Out(None) => break,

            Step::Out(Some(Outbound::Line(line))) => {
                if let Err(e) = write_line(&mut child, &line).await {
                    ending = Ending {
                        error: Some(format!("Could not send to Claude: {e}")),
                        crash_class: e.is_crash_class(),
                    };
                    break;
                }
            }

            Step::Out(Some(Outbound::Interrupt)) => {
                normalizer.mark_interrupted();
                let line = interrupt_request_line(&format!("int_{}", uuid::Uuid::new_v4()));
                if let Err(e) = write_line(&mut child, &line).await {
                    ending = Ending {
                        error: Some(format!("Could not interrupt Claude: {e}")),
                        crash_class: e.is_crash_class(),
                    };
                    break;
                }
                interrupt_deadline = Some(Instant::now() + INTERRUPT_GRACE);
            }

            Step::Out(Some(Outbound::End)) => {
                // Graceful: EOF on stdin, then keep reading until the child
                // flushes its final frames and closes stdout.
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
                    error: Some("Claude did not respond to the interrupt.".into()),
                    crash_class: true,
                };
                break;
            }

            Step::Frame(Ok(Some(value))) => {
                let frame = frame_from_value(value);
                // The raw `AskUserQuestion` input exists only here: the
                // normalized event carries the rendered questions, but the
                // allow payload has to echo the original input back.
                let question_input = raw_question_input(&frame);

                for event in normalizer.normalize(frame) {
                    if !handle_event(
                        &mut child,
                        &session_id,
                        &state,
                        &sink,
                        event,
                        question_input.as_ref(),
                    )
                    .await
                    {
                        // A control response we could not write: the child is
                        // wedged and nothing further will make progress.
                        ending = Ending {
                            error: Some("Lost the connection to Claude.".into()),
                            crash_class: true,
                        };
                        break;
                    }
                }
                if ending.error.is_some() {
                    break;
                }
                // A turn ended — an interrupt (if any) has been answered.
                interrupt_deadline = None;
            }

            // Clean EOF: the CLI exits after its last frame under `--print`.
            Step::Frame(Ok(None)) => break,

            Step::Frame(Err(e)) => {
                ending = Ending {
                    error: Some(match &e {
                        StdioError::IdleTimeout(d) => {
                            format!("Claude went quiet for {}s — ending the session.", d.as_secs())
                        }
                        other => format!("Claude stopped responding: {other}"),
                    }),
                    crash_class: e.is_crash_class(),
                };
                break;
            }
        }
    }

    finish(child, session_id, state, sink, ending).await;
}

/// Record the terminal events and release the child.
async fn finish(
    mut child: StdioChild,
    session_id: String,
    state: Arc<Mutex<SessionState>>,
    sink: Arc<dyn SessionEventSink>,
    ending: Ending,
) {
    // The child's stdout is done talking; give it a moment to exit on its own
    // so the exit code is real, then guarantee the kill.
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

    // Drop the write channel: the session can no longer accept anything, and a
    // command that still holds a sender gets a closed-channel error instead of
    // silently writing into the void.
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

/// The verbatim `AskUserQuestion` tool input, when this frame is one.
fn raw_question_input(frame: &Frame) -> Option<(String, Value)> {
    let Frame::ControlRequest {
        request_id,
        request,
        ..
    } = frame
    else {
        return None;
    };
    parse_can_use_tool(request)
        .filter(|call| call.tool_name == "AskUserQuestion")
        .map(|call| (request_id.clone(), call.input))
}

/// Record one normalized event and emit it. Returns `false` only when an
/// auto-allow reply could not be written — i.e. the session is unrecoverable.
async fn handle_event(
    child: &mut StdioChild,
    session_id: &str,
    state: &Arc<Mutex<SessionState>>,
    sink: &Arc<dyn SessionEventSink>,
    event: SessionEvent,
    question_input: Option<&(String, Value)>,
) -> bool {
    // Policy runs BEFORE the event is recorded or emitted: an auto-allowed tool
    // must leave no trace of a prompt that never happened.
    if let SessionEvent::PermissionRequest {
        request_id,
        tool_name,
        input,
        ..
    } = &event
    {
        let auto = {
            let guard = state.lock().await;
            guard
                .registry
                .get(session_id)
                .map(|session| decide_can_use_tool(session, tool_name))
                // No session record means it was removed; refuse rather than
                // approve a tool call on behalf of a session nobody owns.
                .unwrap_or(AutoDecision::Ask)
        };
        if auto == AutoDecision::Allow {
            let line = control_response_line(request_id, allow_response(input.clone()));
            if let Err(e) = write_line(child, &line).await {
                log(
                    LOG_TAG,
                    &format!("session={session_id} auto-allow write failed: {e}"),
                );
                return false;
            }
            return true;
        }
    }

    let is_question = matches!(event, SessionEvent::QuestionRequest { .. });
    let mut guard = state.lock().await;
    let Some(session) = guard.registry.get_mut(session_id) else {
        return true;
    };
    let Some(outcome) = session.on_event(event.clone(), now_iso()) else {
        // Suppressed (a duplicate exit) — nothing to emit.
        return true;
    };
    if is_question {
        if let Some((request_id, input)) = question_input {
            session.set_pending_question_input(request_id, input.clone());
        }
    }
    drop(guard);

    // A `Truncated` marker is deliberately NOT emitted live: a connected
    // listener already received every event the ring just dropped. It matters
    // only to `agent_session_replay`, which reports it in-band.
    sink.emit_event(session_id, outcome.seq, &event);
    if let Some(change) = outcome.phase_change {
        sink.emit_phase(session_id, change);
    }
    if let Some(needs) = &outcome.needs_you {
        sink.emit_needs_you(session_id, needs);
    }
    true
}

/// Record an event the driver itself synthesized (errors, the exit).
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
        session.on_event(event.clone(), now_iso())
    };
    let Some(outcome) = outcome else {
        return;
    };
    sink.emit_event(session_id, outcome.seq, &event);
    if let Some(change) = outcome.phase_change {
        sink.emit_phase(session_id, change);
    }
}

/// Write one pre-built NDJSON line. The builders in `claude_wire` return
/// strings; the transport writes `Value`s so it can bound and log them.
async fn write_line(child: &mut StdioChild, line: &str) -> Result<(), StdioError> {
    let value: Value = serde_json::from_str(line)?;
    child.write_ndjson(&value).await
}

// ─────────────────────────────────────────────────────────────────────────────
// Command catalog probe
// ─────────────────────────────────────────────────────────────────────────────

/// The `initialize` handshake's answer: the slash-command catalog and the model
/// list the composer's autocomplete and model picker need.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCatalog {
    pub commands: Vec<SlashCommand>,
    pub models: Vec<Value>,
}

/// Ask a throwaway `claude` child for its command catalog.
///
/// A short-lived probe rather than an in-session round trip on purpose: the
/// catalog is needed to *render the composer*, which happens before (and
/// independently of) any session, and folding a control request into a live
/// session's read loop would interleave with a turn in progress for no gain.
/// `initialize` costs no model turn.
pub async fn probe_command_catalog(cwd: PathBuf) -> Result<CommandCatalog, String> {
    let spec = SessionSpec {
        session_id: uuid::Uuid::new_v4().to_string(),
        tool: hq_desktop_core::agent_session::types::SessionTool::Claude,
        cwd: cwd.to_string_lossy().into_owned(),
        company: None,
        model: None,
        effort: None,
        resume: None,
        permission_mode: hq_desktop_core::agent_session::types::PermissionMode::Prompt,
    };
    let mut child = spawn_claude(&spec, cwd).await?;

    let deadline = Instant::now() + PROBE_BUDGET;
    let outcome = probe_inner(&mut child, deadline).await;
    child.shutdown_with_reap(REAP_TIMEOUT).await;
    outcome
}

async fn probe_inner(
    child: &mut StdioChild,
    deadline: Instant,
) -> Result<CommandCatalog, String> {
    let request_id = "init_1";
    write_line(child, &initialize_request_line(request_id))
        .await
        .map_err(|e| format!("Could not ask Claude for its commands: {e}"))?;

    loop {
        let frame = child
            .next_frame(PROBE_BUDGET, deadline)
            .await
            .map_err(|e| format!("Claude did not answer the command probe: {e}"))?;
        let Some(value) = frame else {
            return Err("Claude exited before answering the command probe.".into());
        };
        if let Frame::ControlResponse { response } = frame_from_value(value) {
            return Ok(CommandCatalog {
                commands: parse_initialize_commands(&response),
                models: parse_initialize_models(&response),
            });
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use hq_desktop_core::agent_session::registry::LiveSession;
    use hq_desktop_core::agent_session::types::{
        DoneStatus, PermissionMode, SessionPhase, SessionTool,
    };
    use std::io::Write;
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
        fn emit_event(&self, _session_id: &str, seq: u64, event: &SessionEvent) {
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
            session_id: "sess-e2e".into(),
            tool: SessionTool::Claude,
            cwd: "/hq".into(),
            company: Some("indigo".into()),
            model: Some("haiku".into()),
            effort: None,
            resume: None,
            permission_mode: mode,
        }
    }

    /// A fake `claude` that replays the frames the spike recorded against the
    /// real CLI (claude 2.1.247), including a `can_use_tool` control request it
    /// blocks on until we answer it.
    ///
    /// It is invoked as the launch's `program` with the real `build_args` argv,
    /// so the driver's own launch construction is exercised. (Shadowing the
    /// name on `PATH` instead would mean mutating process-global `PATH` from a
    /// test that runs in parallel with every other test in this binary.)
    const FAKE_CLAUDE: &str = r#"
set -u
# init
printf '%s\n' '{"type":"system","subtype":"init","session_id":"cli-abc","model":"claude-haiku-4-5-20251001","cwd":"/hq","tools":["Bash","Read","Write"],"slash_commands":["hq-whoami","plan"],"permissionMode":"default","capabilities":["interrupt_receipt_v1"]}'
# one streamed text delta
printf '%s\n' '{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Writing the file."}}}'
# the tool call, then the permission request the CLI blocks on
printf '%s\n' '{"type":"assistant","parent_tool_use_id":null,"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"Write","input":{"file_path":"/tmp/hello.txt","content":"hi"}}]}}'
printf '%s\n' '{"type":"control_request","request_id":"req_perm_1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"/tmp/hello.txt","content":"hi"},"permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"tool_use_id":"toolu_01"}}'
# block until the client answers
IFS= read -r reply
printf '%s\n' "$reply" >> "$HQ_FAKE_REPLIES"
printf '%s\n' '{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"File created successfully"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"Done.","usage":{"input_tokens":12,"output_tokens":34},"session_id":"cli-abc","total_cost_usd":0.0012,"duration_ms":2418}'
# stay alive until the client closes stdin, exactly like the real CLI
while IFS= read -r _line; do :; done
exit 0
"#;

    /// The `result` frame the real CLI emits for a turn the client interrupted,
    /// copied verbatim from the spike recording. Note the shape: `subtype` is
    /// `error_during_execution` and `is_error` is true — on the wire an
    /// interrupted turn is indistinguishable from a genuine failure, which is
    /// exactly why the driver's own `mark_interrupted` has to be the signal.
    const INTERRUPTED_RESULT: &str = r#"{"duration_api_ms":0,"stop_reason":null,"session_id":"c551f5ce-a8ed-460e-8d94-3c17ffd83217","total_cost_usd":0,"usage":{"output_tokens_details":{"thinking_tokens":0},"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"aborted_streaming","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subagent_stats":{"spawned":0,"requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,"max_depth":0,"spawned_by_subagents":0,"completed":0,"failed":0,"killed":{"parent":0,"user":0,"system":0},"refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}},"is_error":true,"num_turns":2,"subtype":"error_during_execution","errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],"type":"result","duration_ms":36437,"uuid":"b9629cd0-55b1-4917-97e6-50e8479816be","queued_turn_count":0}"#;

    /// A fake `claude` that streams for a while and then honours an interrupt
    /// the way the spike recorded the real CLI honouring one: the receipt
    /// (`control_response` echoing our `request_id`) first, then the
    /// `error_during_execution` `result`, then it keeps running until stdin
    /// closes.
    ///
    /// The deltas are paced so the interrupt is written into a turn that is
    /// genuinely mid-stream rather than into an already-idle child.
    const FAKE_CLAUDE_INTERRUPT: &str = r#"
set -u
printf '%s\n' '{"type":"system","subtype":"init","session_id":"cli-int","model":"claude-haiku-4-5-20251001","cwd":"/hq","tools":["Bash"],"slash_commands":[],"permissionMode":"default","capabilities":["interrupt_receipt_v1"]}'
for i in 1 2 3 4; do
  printf '{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"tick %s "}}}\n' "$i"
  sleep 0.2
done
# The client's interrupt is waiting in the pipe by now.
IFS= read -r reply
printf '%s\n' "$reply" >> "$HQ_FAKE_REPLIES"
id=$(printf '%s' "$reply" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s","response":{"still_queued":[]}}}\n' "$id"
printf '%s\n' "$HQ_FAKE_RESULT"
# stay alive until the client closes stdin, exactly like the real CLI
while IFS= read -r _line; do :; done
exit 0
"#;

    /// Write `script` to disk as the fake CLI and return its path.
    /// `HQ_FAKE_REPLIES` is where it records what the driver sent back, so the
    /// test can assert on the exact control-response payload.
    fn install_fake(dir: &std::path::Path, replies: &std::path::Path, script: &str) -> String {
        let path = dir.join("fake-claude.sh");
        let mut file = std::fs::File::create(&path).expect("create fake");
        write!(
            file,
            "#!/bin/bash\nexport HQ_FAKE_REPLIES={}\nexport HQ_FAKE_RESULT='{}'\n{script}",
            replies.display(),
            INTERRUPTED_RESULT
        )
        .expect("write fake");
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod fake");
        }
        path.to_string_lossy().into_owned()
    }

    struct Harness {
        state: Arc<Mutex<SessionState>>,
        sink: Arc<RecordingSink>,
        tx: mpsc::UnboundedSender<Outbound>,
        join: tokio::task::JoinHandle<()>,
        _dir: tempfile::TempDir,
        replies: PathBuf,
        /// The fake's pid, captured at spawn so a test can prove the process is
        /// gone once the session ends.
        pid: Option<u32>,
    }

    async fn start(mode: PermissionMode) -> Harness {
        start_with(mode, FAKE_CLAUDE).await
    }

    async fn start_with(mode: PermissionMode, script: &str) -> Harness {
        let dir = tempfile::tempdir().expect("tempdir");
        let replies = dir.path().join("replies.jsonl");
        let program = install_fake(dir.path(), &replies, script);

        let spec = spec(mode);
        let launch = claude_launch(program, &spec, dir.path().to_path_buf());
        // The fake is driven with the real argv, so a build_args regression
        // that broke the CLI invocation would show up here too.
        assert!(launch.args.contains(&"--input-format".to_string()));
        assert!(launch.args.contains(&"stream-json".to_string()));

        let child = StdioChild::spawn(&launch).await.expect("spawn fake");
        let pid = child.pid();

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

    /// Poll until `predicate` holds, or fail. Bounded so a regression is a
    /// failing test rather than a hanging suite.
    async fn until(label: &str, mut predicate: impl FnMut() -> bool) {
        for _ in 0..200 {
            if predicate() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("timed out waiting for {label}");
    }

    #[tokio::test]
    async fn a_prompted_session_parks_a_permission_request_and_resumes_when_allowed() {
        let h = start(PermissionMode::Prompt).await;

        until("the permission request", || !h.sink.needs().is_empty()).await;

        // Started → Idle, and the transcript so far.
        let events = h.sink.events();
        assert!(
            matches!(&events[0].1, SessionEvent::Started { session_id, model, tools, .. }
                if session_id == "cli-abc"
                    && model == "claude-haiku-4-5-20251001"
                    && tools.contains(&"Write".to_string())),
            "first event should be Started: {:?}",
            events[0].1
        );
        assert!(
            events
                .iter()
                .any(|(_, e)| matches!(e, SessionEvent::TextDelta { text, .. } if text == "Writing the file.")),
            "the streamed text reached the sink"
        );
        assert!(
            events
                .iter()
                .any(|(_, e)| matches!(e, SessionEvent::ToolCall { name, .. } if name == "Write")),
            "the tool call reached the sink"
        );

        // Parked, phase NeedsYou, and the UI was told who is blocking.
        let needs = h.sink.needs();
        assert_eq!(needs.len(), 1);
        assert_eq!(needs[0].reason, "permission");
        assert_eq!(needs[0].summary, "Write");
        assert_eq!(needs[0].request_id, "req_perm_1");
        {
            let guard = h.state.lock().await;
            let session = guard.registry.get("sess-e2e").expect("session");
            assert_eq!(session.phase, SessionPhase::NeedsYou);
            assert_eq!(session.pending.len(), 1);
        }
        assert!(
            h.sink.phases().contains(&SessionPhase::NeedsYou),
            "phases: {:?}",
            h.sink.phases()
        );

        // Allow it, exactly as `agent_session_respond_permission` would.
        let input = serde_json::json!({"file_path": "/tmp/hello.txt", "content": "hi"});
        h.tx.send(Outbound::Line(control_response_line(
            "req_perm_1",
            allow_response(input.clone()),
        )))
        .expect("send allow");
        {
            let mut guard = h.state.lock().await;
            guard
                .registry
                .get_mut("sess-e2e")
                .unwrap()
                .on_response_sent("req_perm_1", now_iso());
        }

        // The tool result and a successful turn follow.
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
                SessionEvent::ToolResult { id, is_error: false, .. } if id == "toolu_01"
            )),
            "the tool ran and reported back"
        );
        assert!(
            events.iter().any(|(_, e)| matches!(
                e,
                SessionEvent::TurnDone { status: DoneStatus::Success, .. }
            )),
            "turn ended successfully"
        );
        assert_eq!(
            h.state
                .lock()
                .await
                .registry
                .get("sess-e2e")
                .unwrap()
                .phase,
            SessionPhase::Idle,
            "a finished turn returns to Idle"
        );

        // What we actually put on the wire is the documented allow shape.
        let sent = std::fs::read_to_string(&h.replies).expect("replies");
        let reply: Value = serde_json::from_str(sent.trim()).expect("json");
        assert_eq!(reply["type"], "control_response");
        assert_eq!(reply["response"]["subtype"], "success");
        assert_eq!(reply["response"]["request_id"], "req_perm_1");
        assert_eq!(reply["response"]["response"]["behavior"], "allow");
        assert_eq!(reply["response"]["response"]["updatedInput"], input);

        // Ending closes stdin; the child exits and the session ends exactly once.
        h.tx.send(Outbound::End).expect("send end");
        h.join.await.expect("loop finished");

        let guard = h.state.lock().await;
        let session = guard.registry.get("sess-e2e").expect("session survives for replay");
        assert_eq!(session.phase, SessionPhase::Ended);
        assert!(session.pending.is_empty());
        let exits = session
            .buffer
            .replay(0)
            .events
            .into_iter()
            .filter(|(_, e)| matches!(e, SessionEvent::Exited { .. }))
            .count();
        assert_eq!(exits, 1, "exactly one Exited");
        assert!(
            !guard.has_channel("sess-e2e"),
            "the write channel is released when the child is gone"
        );
    }

    #[tokio::test]
    async fn bypass_mode_auto_allows_and_never_surfaces_a_permission_request() {
        let h = start(PermissionMode::BypassAll).await;

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
        assert!(
            !h.sink.phases().contains(&SessionPhase::NeedsYou),
            "phases: {:?}",
            h.sink.phases()
        );
        assert!(
            events.iter().any(|(_, e)| matches!(
                e,
                SessionEvent::ToolResult { id, .. } if id == "toolu_01"
            )),
            "the tool still ran — the driver answered on the user's behalf"
        );

        // The driver answered with the same allow shape, unprompted.
        let sent = std::fs::read_to_string(&h.replies).expect("replies");
        let reply: Value = serde_json::from_str(sent.trim()).expect("json");
        assert_eq!(reply["response"]["response"]["behavior"], "allow");
        assert_eq!(reply["response"]["request_id"], "req_perm_1");

        h.tx.send(Outbound::End).expect("send end");
        h.join.await.expect("loop finished");
    }

    /// Probe existence without delivering a signal (signal 0).
    #[cfg(unix)]
    fn alive(pid: u32) -> bool {
        // SAFETY: `kill(2)` with signal 0 performs the permission/existence
        // check only; no signal is delivered and no memory is touched.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    /// Bounded wait for the OS to reap `pid`.
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

    /// End-to-end interrupt: a mid-stream turn is stopped, the CLI's receipt +
    /// `error_during_execution` result land, and the session comes back to Idle
    /// as *interrupted* rather than failed.
    ///
    /// The distinction is the whole point. The `result` frame is byte-for-byte
    /// the one a real failure produces (`is_error: true`), so if the driver
    /// ever stopped marking the normalizer before writing the request, the user
    /// would see a red error for having clicked Stop.
    #[tokio::test]
    async fn interrupting_a_streaming_turn_ends_it_as_interrupted_and_returns_to_idle() {
        let h = start_with(PermissionMode::BypassAll, FAKE_CLAUDE_INTERRUPT).await;

        // Wait until the turn is genuinely streaming before stopping it.
        until("the stream to start", || {
            h.sink
                .events()
                .iter()
                .any(|(_, e)| matches!(e, SessionEvent::TextDelta { .. }))
        })
        .await;

        // Exactly what `agent_session_interrupt` posts.
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
                SessionEvent::TurnDone { status: DoneStatus::Interrupted, error: None, .. }
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
            h.state
                .lock()
                .await
                .registry
                .get("sess-e2e")
                .unwrap()
                .phase,
            SessionPhase::Idle,
            "an interrupted turn returns to Idle, ready for the next prompt"
        );

        // The request we actually put on the wire is the documented interrupt
        // shape, and the fake's receipt echoed its id back.
        let sent = std::fs::read_to_string(&h.replies).expect("replies");
        let request: Value = serde_json::from_str(sent.trim()).expect("json");
        assert_eq!(request["type"], "control_request");
        assert_eq!(request["request"]["subtype"], "interrupt");
        assert!(
            request["request_id"]
                .as_str()
                .is_some_and(|id| id.starts_with("int_")),
            "interrupt request id: {}",
            request["request_id"]
        );

        // Now end it exactly as `agent_session_end` does: EOF on stdin, wait,
        // then release the channel and drop the session.
        h.tx.send(Outbound::End).expect("send end");
        h.join.await.expect("loop finished");
        {
            let mut guard = h.state.lock().await;
            guard.close_channel("sess-e2e");
            guard.registry.remove("sess-e2e");
            assert!(!guard.has_channel("sess-e2e"));
        }

        #[cfg(unix)]
        {
            let pid = h.pid.expect("the fake reported a pid");
            assert!(
                until_gone(pid).await,
                "the fake claude (pid {pid}) outlived the session"
            );
        }
    }
}
