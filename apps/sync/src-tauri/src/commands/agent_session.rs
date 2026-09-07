//! The in-app agent sessions command surface.
//!
//! One process-wide [`SessionState`] holds the live sessions and the write
//! channel into each one's driver task. The commands here are thin: they
//! validate, mutate the registry, and post an [`Outbound`] instruction; the
//! driver in [`claude`] owns the child process and the event stream.
//!
//! # Why the state is one mutex over two maps
//!
//! The registry and the channel map are always touched together (start, end,
//! and every respond path), and a second lock is a second lock ordering to get
//! wrong. One `tokio::sync::Mutex`, never held across a child read.
//!
//! # What this surface deliberately does not do
//!
//! It does not resume, it does not run Codex, and it does not persist the
//! transcript. A session's history lives in the CLI's own
//! `~/.claude/projects/**` transcript (which is what Mission Control already
//! reads) plus the bounded in-memory replay ring; this layer only has to be
//! honest about the session that is running right now.

pub mod claude;
pub mod codex;
mod history_replay;
pub mod notify;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use hq_desktop_core::agent_session::claude_wire::{
    allow_response, answers_updated_input, control_response_line, deny_response,
    set_permission_mode_request_line, user_message_line, user_message_line_with_images,
};
use hq_desktop_core::agent_session::codex_wire::{approval_reply, user_input, user_input_reply};
use hq_desktop_core::agent_session::registry::{
    LiveSession, PendingRequest, Replay, SessionRegistry, SessionSummary,
};
use hq_desktop_core::agent_session::types::{
    PermissionDecision, PermissionMode, QuestionAnswer, SessionEvent, SessionPhase, SessionSpec,
    SessionTool, TurnOverrides,
};
use hq_desktop_core::agent_session_flags::ensure_in_app_sessions_allowed;
use hq_desktop_core::claude_launch::check_hq_hooks_ready;
use hq_desktop_core::workspaces::{
    discover_local_companies, humanize_slug, resolve_hq_folder_path,
};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

use crate::util::logfile::log;

use self::claude::{Outbound, SessionEventSink};

const LOG_TAG: &str = "agent-session";

/// A running turn that emits nothing for ten minutes is plausibly wedged.
const ACTIVE_TURN_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
/// Absolute lifetime bound for one child. Parked sessions use a longer idle
/// deadline so this hard bound, not ordinary inactivity, owns eventual cleanup.
pub(super) const SESSION_HARD_DEADLINE: std::time::Duration =
    std::time::Duration::from_secs(24 * 60 * 60);
const PARKED_SESSION_IDLE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(25 * 60 * 60);

/// Idle and Needs You are healthy parked states, not stalled processes. Only a
/// turn that is Starting or Working gets the short silence watchdog.
pub(super) fn driver_idle_timeout(phase: Option<SessionPhase>) -> std::time::Duration {
    match phase {
        Some(SessionPhase::Idle | SessionPhase::NeedsYou) => PARKED_SESSION_IDLE_TIMEOUT,
        _ => ACTIVE_TURN_IDLE_TIMEOUT,
    }
}

/// How long `agent_session_end` waits for a graceful exit before killing.
const END_GRACE: std::time::Duration = std::time::Duration::from_secs(5);
const END_POLL: std::time::Duration = std::time::Duration::from_millis(100);

// ─────────────────────────────────────────────────────────────────────────────
// Shared state
// ─────────────────────────────────────────────────────────────────────────────

/// Live sessions plus the write channel into each one's driver task.
#[derive(Default)]
pub struct SessionState {
    pub registry: SessionRegistry,
    channels: HashMap<String, UnboundedSender<Outbound>>,
}

impl SessionState {
    pub fn set_channel(&mut self, session_id: &str, tx: UnboundedSender<Outbound>) {
        self.channels.insert(session_id.to_owned(), tx);
    }

    /// Forget a session's write channel. Called when its child is gone, so a
    /// later `send` fails loudly instead of writing into a dead pipe.
    pub fn close_channel(&mut self, session_id: &str) {
        self.channels.remove(session_id);
    }

    pub fn has_channel(&self, session_id: &str) -> bool {
        self.channels.contains_key(session_id)
    }

    fn send(&self, session_id: &str, message: Outbound) -> Result<(), String> {
        let tx = self
            .channels
            .get(session_id)
            .ok_or_else(|| format!("Session {session_id} is not running."))?;
        tx.send(message)
            .map_err(|_| format!("Session {session_id} has already ended."))
    }
}

/// A child that has been started (and, for Codex, handshaken) but not yet
/// handed to its driver task. Boxed handshake because it is much larger than
/// the Claude arm, and a lopsided enum would pay for that on every start.
enum Spawned {
    Claude(hq_desktop_core::stdio::StdioChild),
    Codex(
        hq_desktop_core::stdio::StdioChild,
        Box<codex::CodexHandshake>,
    ),
}

/// Which CLI a live session is driving.
///
/// Read from the REGISTRY rather than taken as a command argument: the tool is
/// a property of the running session, and trusting the caller to restate it
/// would let a stale frontend send Claude-shaped bytes to a Codex child.
fn session_tool(guard: &SessionState, session_id: &str) -> Result<SessionTool, String> {
    guard
        .registry
        .get(session_id)
        .map(|session| session.spec.tool)
        .ok_or_else(|| format!("Session {session_id} is not running."))
}

fn state() -> Arc<Mutex<SessionState>> {
    static STATE: OnceLock<Arc<Mutex<SessionState>>> = OnceLock::new();
    STATE
        .get_or_init(|| Arc::new(Mutex::new(SessionState::default())))
        .clone()
}

/// ISO-8601 UTC to the millisecond — the timestamp format every other HQ
/// desktop record uses.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Unix milliseconds — the stamp every buffered event carries.
///
/// Separate from [`now_iso`] rather than parsed back out of it: the registry is
/// deliberately clock-free and takes the instant as a number, and a numeric
/// stamp is what the UI needs to draw a day divider without re-parsing a
/// string on every event. A pre-1970 clock cannot produce a sensible stamp, so
/// it saturates at 0 instead of wrapping.
pub fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire payloads
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyOption {
    pub slug: String,
    pub display_name: String,
    pub cloud_uid: Option<String>,
}

/// Everything the UI needs to decide whether it can offer a session at all,
/// and what to say when it cannot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub hq_root: String,
    /// True when `.claude/settings.json` wires the hooks a session depends on.
    pub hooks_ready: bool,
    pub hooks_error: Option<String>,
    pub claude_available: bool,
    /// The Claude Code CLI must be signed in separately from Claude Desktop.
    /// The spike's sessions failed at the model call, not at spawn, when it was
    /// not — so this is a first-class preflight signal, not a detail.
    pub claude_logged_in: bool,
    pub codex_available: bool,
    /// The Codex CLI signs in separately from the ChatGPT desktop app, and a
    /// signed-out CLI starts fine and then fails at the model call — so this
    /// is a preflight signal for the same reason `claude_logged_in` is.
    pub codex_logged_in: bool,
    pub companies: Vec<CompanyOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedSession {
    pub session_id: String,
}

/// One image attached to a user turn: raw base64, no data-URL prefix.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub media_type: String,
    pub base64: String,
}

/// What `workspace/sessions/<id>/meta.yaml` carries. Key names mirror
/// `hq_desktop_core::sessions::claude`'s reader exactly — this file exists so
/// an in-app session shows up company-tagged in the existing history feed.
#[derive(Debug, Serialize)]
struct SessionMetaOut {
    company_slug: Option<String>,
    started_at: String,
    /// Human conversation title derived from the first visible operator turn.
    /// Project-channel rows use this after the live process exits.
    title: Option<String>,
    /// Which CLI ran the session. The reader ignores unknown keys, so this is
    /// additive — but without it a Codex transcript on disk is indistinguishable
    /// from a Claude one.
    tool: String,
    /// The CLI's OWN session handle, which is what a resume needs and what our
    /// session id is not. Codex supplies it during its handshake; Claude fills
    /// it when the child's `init` frame lands.
    cli_session_id: Option<String>,
    /// The company project the session is bound to (directory slug). The
    /// history reader already parses this key; the sidebar's project links
    /// read it from disk for sessions that are no longer live.
    project: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/// Can this device run an in-app session, and against which companies?
#[tauri::command]
pub async fn agent_session_preflight() -> Result<Preflight, String> {
    ensure_in_app_sessions_allowed()?;
    let hq_root = resolve_hq_folder_path()?;

    let hooks_error = check_hq_hooks_ready(&hq_root).err();
    let tools = crate::commands::ai_tools::detect_ai_tools();
    let ready = crate::commands::ai_tools::detect_claude_ready();

    // Only worth a subprocess when there is a CLI to ask.
    let codex_logged_in = tools.codex_cli && codex::codex_logged_in().await;

    let (entries, _manifest_error) = discover_local_companies(&hq_root);
    let companies = entries
        .into_iter()
        .map(|entry| CompanyOption {
            display_name: entry
                .display_name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| humanize_slug(&entry.slug)),
            slug: entry.slug,
            cloud_uid: entry.cloud_uid,
        })
        .collect();

    Ok(Preflight {
        hq_root: hq_root.to_string_lossy().into_owned(),
        hooks_ready: hooks_error.is_none(),
        hooks_error,
        claude_available: tools.claude_cli,
        claude_logged_in: ready.logged_in,
        codex_available: tools.codex_cli,
        codex_logged_in,
        companies,
    })
}

/// Start a session and begin driving it.
#[tauri::command]
pub async fn agent_session_start(
    app: tauri::AppHandle,
    spec: SessionSpec,
    project_channel_id: Option<String>,
) -> Result<StartedSession, String> {
    ensure_in_app_sessions_allowed()?;

    let hq_root = resolve_hq_folder_path()?;
    // The session always runs from the HQ root. Anywhere else is a different
    // Claude Code project, where none of HQ's hooks or policies fire.
    let mut spec = spec;
    spec.cwd = hq_root.to_string_lossy().into_owned();
    if spec.session_id.trim().is_empty() {
        spec.session_id = uuid::Uuid::new_v4().to_string();
    }
    let session_id = spec.session_id.clone();

    // A provider resume restores the model's context, but neither CLI re-emits
    // the conversation that preceded it. Seed the new app-owned replay ring
    // from the provider's bounded on-disk transcript so Resume opens a visible
    // conversation instead of an apparently empty chat.
    let resumed_history = spec
        .resume
        .as_deref()
        .map(str::trim)
        .filter(|resume| !resume.is_empty())
        .map(|resume| history_replay::load_resume_history(spec.tool, resume))
        .unwrap_or_default();

    let state = state();

    // Reserve the slot BEFORE spawning: refusing after a child is already
    // running would leak a process for the length of the error message.
    {
        let mut guard = state.lock().await;
        if guard
            .registry
            .get(&session_id)
            .is_some_and(|s| !s.is_ended())
        {
            return Err(format!("Session {session_id} is already running."));
        }
        let mut session = LiveSession::new(spec.clone(), now_iso());
        session.history_before = resumed_history.before;
        for historical in resumed_history.events {
            if let SessionEvent::UserMessage { text, .. } = &historical.event {
                session.adopt_title_from_prompt(text);
            }
            session
                .buffer
                .push(historical.event, historical.received_at_ms);
        }
        guard.registry.insert(session)?;
    }

    // Dispatch by tool. Both drivers own their child, their wire, and their
    // normalizer, and both reduce to the same event stream on the same
    // channel — which is why everything downstream of here is tool-agnostic.
    let spawned = match spec.tool {
        SessionTool::Claude => claude::spawn_claude(&spec, hq_root.clone())
            .await
            .map(Spawned::Claude),
        SessionTool::Codex => match codex::spawn_codex(hq_root.clone()).await {
            Ok(mut child) => match codex::handshake(&mut child, &spec).await {
                Ok(handshake) => Ok(Spawned::Codex(child, Box::new(handshake))),
                Err(e) => {
                    // A child whose handshake failed is not a session; reap it
                    // rather than leak it for the length of the error message.
                    child
                        .shutdown_with_reap(hq_desktop_core::stdio::child::REAP_TIMEOUT)
                        .await;
                    Err(e)
                }
            },
            Err(e) => Err(e),
        },
    };
    let spawned = match spawned {
        Ok(spawned) => spawned,
        Err(e) => {
            state.lock().await.registry.remove(&session_id);
            return Err(e);
        }
    };

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    state.lock().await.set_channel(&session_id, tx);

    if let Err(error) = super::project_session_sharing::prepare(&app, &spec, project_channel_id.as_deref()).await {
        use tauri::Emitter;
        // Sharing is independent of running the owner's local conversation.
        let _ = app.emit("project-session:sharing-status", serde_json::json!({ "sessionId": session_id, "error": error }));
    }

    let sink: Arc<dyn SessionEventSink> = Arc::new(claude::AppSink(app));
    // Persist the app-owned metadata before starting either read loop. Claude
    // can announce its native id immediately, so writing after spawn creates a
    // race where the link update has no file to update.
    let cli_session_id = match &spawned {
        Spawned::Claude(_) => None,
        Spawned::Codex(_, handshake) => Some(handshake.thread_id.clone()),
    };
    if let Err(e) = write_session_meta(
        &hq_root,
        &session_id,
        spec.company.as_deref(),
        spec.tool,
        cli_session_id.as_deref(),
        spec.project.as_deref(),
    ) {
        log(
            LOG_TAG,
            &format!("session={session_id} meta write failed: {e}"),
        );
    }

    match spawned {
        Spawned::Claude(child) => {
            tokio::spawn(claude::run_session_loop(
                child,
                session_id.clone(),
                hq_root.clone(),
                state.clone(),
                sink,
                rx,
            ));
        }
        Spawned::Codex(child, handshake) => {
            // Codex's own thread id is the resume handle; the registry key
            // stays our session id, so nothing downstream has to know.
            if let Some(session) = state.lock().await.registry.get_mut(&session_id) {
                session.cli_session_id = Some(handshake.thread_id.clone());
            }
            tokio::spawn(codex::run_session_loop(
                child,
                session_id.clone(),
                spec.clone(),
                *handshake,
                state.clone(),
                sink,
                rx,
            ));
        }
    }

    log(LOG_TAG, &format!("session={session_id} started"));
    Ok(StartedSession { session_id })
}

/// Send a user turn (or steer an in-flight one).
///
/// `overrides` carries the composer's model / effort pills when they no longer
/// match the live session. Changing a model or a thinking effort must never
/// start a new chat — only a company change forks, because a company is what
/// binds the session's context — so they are applied to the session IN PLACE
/// on the tool that can honour them.
#[tauri::command]
pub async fn agent_session_send(
    app: tauri::AppHandle,
    session_id: String,
    text: String,
    images: Option<Vec<ImageAttachment>>,
    overrides: Option<TurnOverrides>,
) -> Result<(), String> {
    ensure_in_app_sessions_allowed()?;
    let attachments: Vec<(String, String)> = images
        .unwrap_or_default()
        .into_iter()
        .map(|image| (image.media_type, image.base64))
        .collect();
    let state = state();
    let mut guard = state.lock().await;

    let tool = session_tool(&guard, &session_id)?;

    // BEFORE the turn is queued: the driver reads the options when it builds
    // the `turn/start`, so an instruction that arrived after the line would
    // land one turn late.
    //
    // Codex ONLY. A running `claude --print` is pinned to the model and effort
    // it was launched with, and recording a change the child cannot honour
    // would make the session list — and the strip's title — name a model that
    // is not answering. The UI tells that operator their choice lands on their
    // next session instead.
    if let (Some(overrides), SessionTool::Codex) = (overrides, tool) {
        if let Some(session) = guard.registry.get_mut(&session_id) {
            session.apply_turn_overrides(&overrides);
        }
        guard.send(&session_id, Outbound::SetTurnOptions(overrides))?;
    }

    // Slash commands need no client-side expansion on either CLI: both execute
    // them from a plain user turn (verified against claude 2.1.247 and
    // codex-cli 0.144.1).
    let line = match tool {
        SessionTool::Claude if attachments.is_empty() => user_message_line(&text),
        SessionTool::Claude => user_message_line_with_images(&text, &attachments),
        // Codex takes the turn's `input` array; JSON keeps the attachments
        // intact across the string-shaped outbound channel.
        SessionTool::Codex => user_input(&text, &attachments).to_string(),
    };
    let result = record_and_queue_user_turn(
        &mut guard,
        &claude::AppSink(app),
        &session_id,
        &text,
        line,
        attachments.len() as u32,
    );
    let title = result.as_ref().ok().and_then(|_| {
        guard
            .registry
            .get(&session_id)
            .map(|session| session.summary().title)
            .filter(|title| !title.trim().is_empty())
    });
    drop(guard);

    if let Some(title) = title {
        if let Ok(hq_root) = resolve_hq_folder_path() {
            match update_session_meta_title(&hq_root, &session_id, &title) {
                Ok(true) => crate::commands::session_project_links::invalidate_links_cache(),
                Ok(false) => {}
                Err(e) => log(
                    LOG_TAG,
                    &format!("session={session_id} title meta write failed: {e}"),
                ),
            }
        }
    }

    result
}

/// Buffer the operator's turn, then queue the line that carries it.
///
/// Split out of [`agent_session_send`] so the driver's end-to-end test can run
/// the REAL ordering against a real child instead of restating it. The order is
/// the point: the CLI acknowledges nothing when a user line lands, so this is
/// the only place the transcript can learn what was asked, and recording it
/// under the same lock — ahead of the write — is what guarantees a replayed
/// session reads user → agent rather than agent alone.
pub(crate) fn record_and_queue_user_turn(
    guard: &mut SessionState,
    sink: &dyn SessionEventSink,
    session_id: &str,
    text: &str,
    line: String,
    image_count: u32,
) -> Result<(), String> {
    // Refuse before recording: a turn buffered for a session that cannot
    // receive it would show in the transcript as something the operator said
    // and the agent ignored.
    if !guard.has_channel(session_id) {
        return Err(format!("Session {session_id} is not running."));
    }

    if let Some(session) = guard.registry.get_mut(session_id) {
        let event = SessionEvent::UserMessage {
            text: text.to_owned(),
            // The bytes stay out of the ring: they are megabytes of base64 the
            // model has already seen, and buffering them would evict real
            // transcript to hold a picture nothing re-reads.
            image_count,
        };
        if let Some(outcome) = session.on_event(event.clone(), now_iso(), now_ms()) {
            sink.emit_event(session_id, outcome.seq, outcome.received_at_ms, &event);
        }
    }

    guard.send(session_id, Outbound::Line(line))?;
    if let Some(session) = guard.registry.get_mut(session_id) {
        if let Some(change) = session.on_user_send(now_iso()) {
            sink.emit_phase(session_id, change);
        }
    }
    Ok(())
}

/// Answer a parked tool-permission request.
#[tauri::command]
pub async fn agent_session_respond_permission(
    app: tauri::AppHandle,
    session_id: String,
    request_id: String,
    decision: PermissionDecision,
) -> Result<(), String> {
    ensure_in_app_sessions_allowed()?;
    let state = state();
    let mut guard = state.lock().await;

    let session = guard
        .registry
        .get_mut(&session_id)
        .ok_or_else(|| format!("Session {session_id} is not running."))?;
    let Some(PendingRequest::Permission { tool_name, input }) = session.pending.get(&request_id)
    else {
        return Err(format!("Request {request_id} is no longer waiting."));
    };
    let tool_name = tool_name.clone();
    let input = input.clone();

    // `allowSession` is session-scoped memory on BOTH wires — never a durable
    // settings edit, and never Codex's own `acceptForSession`, which would
    // write an allowance the user only granted a chat window.
    if matches!(decision, PermissionDecision::AllowSession) {
        session.remember_allowed_tool(&tool_name);
    }
    let tool = session.spec.tool;

    let message = match tool {
        SessionTool::Claude => {
            let response = match &decision {
                PermissionDecision::AllowOnce | PermissionDecision::AllowSession => {
                    allow_response(input)
                }
                PermissionDecision::Allow { updated_input } => {
                    allow_response(updated_input.clone())
                }
                PermissionDecision::Deny { message } => deny_response(message),
            };
            Outbound::Line(control_response_line(&request_id, response))
        }
        // Codex takes accept/decline and nothing else: it has no notion of a
        // rewritten tool input, so an `allow` with edits is still an accept.
        SessionTool::Codex => Outbound::Reply {
            request_id: request_id.clone(),
            result: approval_reply(!matches!(decision, PermissionDecision::Deny { .. })),
        },
    };

    guard.send(&session_id, message)?;
    if let Some(session) = guard.registry.get_mut(&session_id) {
        if let Some(change) = session.on_response_sent(&request_id, now_iso()) {
            claude::AppSink(app).emit_phase(&session_id, change);
        }
    }
    Ok(())
}

/// Answer a parked `AskUserQuestion`.
#[tauri::command]
pub async fn agent_session_answer_question(
    app: tauri::AppHandle,
    session_id: String,
    request_id: String,
    answers: Vec<QuestionAnswer>,
) -> Result<(), String> {
    ensure_in_app_sessions_allowed()?;
    let state = state();
    let mut guard = state.lock().await;

    let session = guard
        .registry
        .get(&session_id)
        .ok_or_else(|| format!("Session {session_id} is not running."))?;
    let Some(PendingRequest::Question { questions, input }) = session.pending.get(&request_id)
    else {
        return Err(format!("Request {request_id} is no longer waiting."));
    };

    let message = match session.spec.tool {
        // `AskUserQuestion` is answered by ALLOWING the tool call with the
        // answers merged into its input, keyed by question text — not by a
        // bespoke reply.
        SessionTool::Claude => Outbound::Line(control_response_line(
            &request_id,
            allow_response(answers_updated_input(input, &answers, questions)),
        )),
        // Codex answers on the request's own JSON-RPC id, keyed by each
        // question's wire id (which `Question::id` carries).
        SessionTool::Codex => Outbound::Reply {
            request_id: request_id.clone(),
            result: user_input_reply(questions, &answers),
        },
    };
    guard.send(&session_id, message)?;
    if let Some(session) = guard.registry.get_mut(&session_id) {
        if let Some(change) = session.on_response_sent(&request_id, now_iso()) {
            claude::AppSink(app).emit_phase(&session_id, change);
        }
    }
    Ok(())
}

/// Stop the current turn without ending the session.
#[tauri::command]
pub async fn agent_session_interrupt(session_id: String) -> Result<(), String> {
    ensure_in_app_sessions_allowed()?;
    // The driver marks the normalizer interrupted before it writes the request
    // — the ordering is why this is an instruction rather than two calls.
    state().lock().await.send(&session_id, Outbound::Interrupt)
}

/// Change how tool-permission requests are answered, WITHOUT starting a new
/// session.
///
/// Two halves, because the two CLIs gate at different layers:
///   - HQ's own gate moves immediately (`decide_can_use_tool` reads the spec),
///     which is what makes `bypassAll` stop parking prompts on both tools;
///   - the CLI's gate is told too — Claude over its control channel, Codex by
///     rebinding the `approvalPolicy` its next `turn/start` carries.
///
/// Claude's `set_permission_mode` is best-effort: a CLI that refuses the
/// subtype answers with an error `control_response`, which the normalizer maps
/// to nothing rather than to a red transcript. The user-visible behaviour is
/// already correct without it, because HQ answers `can_use_tool` itself.
#[tauri::command]
pub async fn agent_session_set_permission_mode(
    session_id: String,
    mode: PermissionMode,
) -> Result<(), String> {
    ensure_in_app_sessions_allowed()?;
    let state = state();
    let mut guard = state.lock().await;

    let tool = session_tool(&guard, &session_id)?;
    if let Some(session) = guard.registry.get_mut(&session_id) {
        session.set_permission_mode(mode);
    }
    let message = match tool {
        SessionTool::Claude => Outbound::Line(set_permission_mode_request_line(
            &format!("perm_{}", uuid::Uuid::new_v4()),
            mode,
        )),
        SessionTool::Codex => Outbound::SetPermissionMode(mode),
    };
    guard.send(&session_id, message)
}

/// End a session: EOF on stdin, then a bounded wait, then a kill.
#[tauri::command]
pub async fn agent_session_end(session_id: String) -> Result<(), String> {
    ensure_in_app_sessions_allowed()?;
    let state = state();
    {
        let guard = state.lock().await;
        if !guard.registry.contains(&session_id) {
            return Ok(()); // Already gone; ending twice is not an error.
        }
        // A session whose child already died has no channel — fall straight
        // through to removal rather than manufacturing an error to discard.
        // Ending must always succeed from the user's point of view — a session
        // whose driver task is already gone is simply removed below.
        if guard.has_channel(&session_id) {
            if let Err(e) = guard.send(&session_id, Outbound::End) {
                log(
                    LOG_TAG,
                    &format!("session={session_id} end not delivered: {e}"),
                );
            }
        }
    }

    if !wait_until_ended(&state, &session_id, END_GRACE).await {
        log(
            LOG_TAG,
            &format!("session={session_id} ignored stdin close — killing it"),
        );
        let _ = state.lock().await.send(&session_id, Outbound::Kill);
        wait_until_ended(&state, &session_id, END_GRACE).await;
    }

    let mut guard = state.lock().await;
    guard.close_channel(&session_id);
    guard.registry.remove(&session_id);
    log(LOG_TAG, &format!("session={session_id} ended"));
    Ok(())
}

/// Every session this app is driving.
#[tauri::command]
pub async fn agent_session_list() -> Result<Vec<SessionSummary>, String> {
    ensure_in_app_sessions_allowed()?;
    Ok(state().lock().await.registry.snapshot())
}

/// Catch a reconnecting UI up from `since_seq`.
#[tauri::command]
pub async fn agent_session_replay(session_id: String, since_seq: u64) -> Result<Replay, String> {
    ensure_in_app_sessions_allowed()?;
    let state = state();
    let guard = state.lock().await;
    let session = guard
        .registry
        .get(&session_id)
        .ok_or_else(|| format!("No session {session_id}."))?;
    Ok(session.buffer.replay(since_seq))
}

/// Load the page immediately before `before` from the provider's durable
/// transcript. Live replay stays bounded and fast; the UI asks for older prose
/// only when the reader scrolls back for it.
#[tauri::command]
pub async fn agent_session_history_page(
    session_id: String,
    before: Option<u64>,
    tool: Option<SessionTool>,
) -> Result<history_replay::HistoryPage, String> {
    ensure_in_app_sessions_allowed()?;
    // A dormant provider conversation is readable without becoming a live HQ
    // process. Its native id and provider are already known by the history
    // scanner, so no registry entry is needed just to render the transcript.
    if let Some(tool) = tool {
        return Ok(history_replay::load_resume_history_before(
            tool,
            &session_id,
            before,
        ));
    }

    let before = before.ok_or_else(|| "An earlier-history cursor is required.".to_string())?;
    let state = state();
    let guard = state.lock().await;
    let session = guard
        .registry
        .get(&session_id)
        .ok_or_else(|| format!("No session {session_id}."))?;
    let resume = session
        .spec
        .resume
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "This session has no earlier provider transcript.".to_string())?
        .to_owned();
    let tool = session.spec.tool;
    drop(guard);
    Ok(history_replay::load_resume_history_before(
        tool,
        &resume,
        Some(before),
    ))
}

/// The id the CLI itself knows a session by — what `claude --resume` and
/// `codex resume` take.
///
/// For Claude this is the id the app minted on `--session-id` (or, after a
/// resume, the one `system:init` reported); for Codex it is the thread id the
/// handshake announced. `None` until that handshake has landed. The frontend
/// reads the same value off its own `started` event and only asks here when
/// the event ring has dropped it.
#[tauri::command]
pub async fn agent_session_cli_session_id(session_id: String) -> Result<Option<String>, String> {
    ensure_in_app_sessions_allowed()?;
    let state = state();
    let guard = state.lock().await;
    cli_session_id_of(&guard.registry, &session_id)
}

/// Registry half of [`agent_session_cli_session_id`], kept free of the global
/// lock so it can be exercised with a bare registry.
fn cli_session_id_of(
    registry: &SessionRegistry,
    session_id: &str,
) -> Result<Option<String>, String> {
    registry
        .get(session_id)
        .map(|session| session.cli_session_id.clone())
        .ok_or_else(|| format!("No session {session_id}."))
}

/// The CLI's slash-command catalog and model list, for the composer.
#[tauri::command]
pub async fn agent_session_slash_commands(
    tool: SessionTool,
) -> Result<claude::CommandCatalog, String> {
    ensure_in_app_sessions_allowed()?;
    let hq_root = resolve_hq_folder_path()?;
    match tool {
        SessionTool::Claude => claude::probe_command_catalog(hq_root).await,
        SessionTool::Codex => codex::probe_command_catalog(hq_root).await,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Poll for the session's phase to reach `Ended`. Polling rather than a
/// notification because the thing we are waiting on is a child process exiting,
/// which the driver observes and we do not.
async fn wait_until_ended(
    state: &Arc<Mutex<SessionState>>,
    session_id: &str,
    budget: std::time::Duration,
) -> bool {
    let deadline = std::time::Instant::now() + budget;
    loop {
        {
            let guard = state.lock().await;
            match guard.registry.get(session_id) {
                None => return true,
                Some(session) if session.phase == SessionPhase::Ended => return true,
                Some(_) => {}
            }
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(END_POLL).await;
    }
}

/// Stamp `workspace/sessions/<id>/meta.yaml` so the existing session-history
/// reader can enrich this session with its company and true start time.
fn write_session_meta(
    hq_root: &Path,
    session_id: &str,
    company: Option<&str>,
    tool: SessionTool,
    cli_session_id: Option<&str>,
    project: Option<&str>,
) -> Result<(), String> {
    let dir = hq_root.join("workspace").join("sessions").join(session_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let meta = SessionMetaOut {
        company_slug: company
            .map(str::trim)
            .filter(|slug| !slug.is_empty())
            .map(str::to_owned),
        started_at: now_iso(),
        title: None,
        tool: match tool {
            SessionTool::Claude => "claude".into(),
            SessionTool::Codex => "codex".into(),
        },
        cli_session_id: cli_session_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned),
        project: project
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_owned),
    };
    let yaml = serde_yaml::to_string(&meta).map_err(|e| format!("serialize meta: {e}"))?;
    std::fs::write(dir.join("meta.yaml"), yaml).map_err(|e| format!("write meta.yaml: {e}"))
}

/// Rewrite ONLY the `project` key of an existing meta.yaml, keeping every
/// other key (including ones this app never wrote) intact. Used when HQ
/// creates a project mid-session and the session is bound to it after the
/// fact.
fn update_session_meta_project(
    hq_root: &Path,
    session_id: &str,
    project: &str,
) -> Result<(), String> {
    // A session id is a client-minted token, never a path.
    if session_id.contains(['/', '\\']) || session_id == "." || session_id == ".." {
        return Err("invalid session id".to_string());
    }
    let path = hq_root
        .join("workspace")
        .join("sessions")
        .join(session_id)
        .join("meta.yaml");
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read meta.yaml: {e}"))?;
    let mut doc: serde_yaml::Value =
        serde_yaml::from_str(&raw).map_err(|e| format!("parse meta.yaml: {e}"))?;
    let serde_yaml::Value::Mapping(map) = &mut doc else {
        return Err("meta.yaml is not a mapping".to_string());
    };
    map.insert(
        serde_yaml::Value::String("project".into()),
        serde_yaml::Value::String(project.trim().to_string()),
    );
    let yaml = serde_yaml::to_string(&doc).map_err(|e| format!("serialize meta: {e}"))?;
    std::fs::write(&path, yaml).map_err(|e| format!("write meta.yaml: {e}"))
}

/// Persist the session's human title without disturbing company, project, CLI
/// id, or any future metadata keys. Returns true only when the file changed.
fn update_session_meta_title(
    hq_root: &Path,
    session_id: &str,
    title: &str,
) -> Result<bool, String> {
    if session_id.contains(['/', '\\']) || session_id == "." || session_id == ".." {
        return Err("invalid session id".to_string());
    }
    let title = title.trim();
    if title.is_empty() {
        return Ok(false);
    }
    let path = hq_root
        .join("workspace")
        .join("sessions")
        .join(session_id)
        .join("meta.yaml");
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read meta.yaml: {e}"))?;
    let mut doc: serde_yaml::Value =
        serde_yaml::from_str(&raw).map_err(|e| format!("parse meta.yaml: {e}"))?;
    let serde_yaml::Value::Mapping(map) = &mut doc else {
        return Err("meta.yaml is not a mapping".to_string());
    };
    let key = serde_yaml::Value::String("title".into());
    if map
        .get(&key)
        .and_then(serde_yaml::Value::as_str)
        .is_some_and(|current| current.trim() == title)
    {
        return Ok(false);
    }
    map.insert(key, serde_yaml::Value::String(title.to_string()));
    let yaml = serde_yaml::to_string(&doc).map_err(|e| format!("serialize meta: {e}"))?;
    std::fs::write(&path, yaml).map_err(|e| format!("write meta.yaml: {e}"))?;
    Ok(true)
}

/// Link an app-owned session record to the provider-native transcript id once
/// Claude announces it. This deliberately updates the existing app directory
/// instead of creating a second metadata directory that would look like a
/// duplicate session to project/channel joins.
pub(super) fn update_session_meta_cli_session_id(
    hq_root: &Path,
    session_id: &str,
    cli_session_id: &str,
) -> Result<(), String> {
    if session_id.contains(['/', '\\']) || session_id == "." || session_id == ".." {
        return Err("invalid session id".to_string());
    }
    let cli_session_id = cli_session_id.trim();
    if cli_session_id.is_empty() {
        return Err("native session id is blank".to_string());
    }
    let path = hq_root
        .join("workspace")
        .join("sessions")
        .join(session_id)
        .join("meta.yaml");
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read meta.yaml: {e}"))?;
    let mut doc: serde_yaml::Value =
        serde_yaml::from_str(&raw).map_err(|e| format!("parse meta.yaml: {e}"))?;
    let serde_yaml::Value::Mapping(map) = &mut doc else {
        return Err("meta.yaml is not a mapping".to_string());
    };
    map.insert(
        serde_yaml::Value::String("cli_session_id".into()),
        serde_yaml::Value::String(cli_session_id.to_string()),
    );
    let yaml = serde_yaml::to_string(&doc).map_err(|e| format!("serialize meta: {e}"))?;
    std::fs::write(&path, yaml).map_err(|e| format!("write meta.yaml: {e}"))
}

/// The process-wide registry, for sibling modules' tests that need to seed a
/// live session without spawning a child.
#[cfg(test)]
pub(crate) fn test_registry() -> Arc<Mutex<SessionState>> {
    state()
}

/// Every session the registry is driving — for the project-links join and
/// the project watch, which run outside a command.
pub(crate) async fn live_session_summaries() -> Vec<SessionSummary> {
    state().lock().await.registry.snapshot()
}

/// Bind a live session to a company project: the registry (so every summary
/// reports it at once) and its meta.yaml (so the binding outlives the
/// process). Returns whether the registry binding changed; a meta write
/// failure is reported but does not undo the in-memory binding.
pub(crate) async fn bind_session_project(
    hq_root: &Path,
    session_id: &str,
    project: &str,
) -> Result<bool, String> {
    let changed = {
        let state = state();
        let mut guard = state.lock().await;
        let session = guard
            .registry
            .get_mut(session_id)
            .ok_or_else(|| format!("Session {session_id} is not running."))?;
        session.bind_project(Some(project))
    };
    if changed {
        if let Err(e) = update_session_meta_project(hq_root, session_id, project) {
            log(
                LOG_TAG,
                &format!("session={session_id} meta project write failed: {e}"),
            );
        }
    }
    Ok(changed)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parked_sessions_do_not_expire_from_ten_minutes_of_silence() {
        assert!(driver_idle_timeout(Some(SessionPhase::Idle)) > SESSION_HARD_DEADLINE);
        assert!(driver_idle_timeout(Some(SessionPhase::NeedsYou)) > SESSION_HARD_DEADLINE);
        assert_eq!(
            driver_idle_timeout(Some(SessionPhase::Working)),
            std::time::Duration::from_secs(600)
        );
        assert_eq!(
            driver_idle_timeout(Some(SessionPhase::Starting)),
            std::time::Duration::from_secs(600)
        );
    }

    /// "Open in Claude Code / Codex" needs the id the CLI knows the session
    /// by. It is `None` before the handshake and whatever `Started` announced
    /// after it — for Codex that is the thread id, which is not the app's own.
    #[test]
    fn cli_session_id_is_none_until_the_handshake_then_what_started_announced() {
        let mut registry = SessionRegistry::new();
        let spec = SessionSpec {
            session_id: "app-1".into(),
            title: None,
            tool: SessionTool::Codex,
            cwd: "/hq".into(),
            company: Some("indigo".into()),
            project: None,
            model: None,
            effort: None,
            resume: None,
            permission_mode: PermissionMode::Prompt,
        };
        registry
            .insert(LiveSession::new(spec, "2026-09-02T00:00:00Z".into()))
            .expect("insert");

        assert_eq!(cli_session_id_of(&registry, "app-1"), Ok(None));
        assert!(cli_session_id_of(&registry, "missing").is_err());

        let started = SessionEvent::Started {
            session_id: "01a06218-e436-7963-827b-6103963b4320".into(),
            tool: SessionTool::Codex,
            model: "gpt-5.6-codex".into(),
            cwd: "/hq".into(),
            tools: vec![],
            commands: vec![],
            permission_mode: None,
            capabilities: vec![],
        };
        registry
            .get_mut("app-1")
            .expect("live")
            .on_event(started, "2026-09-02T00:00:01Z".into(), 1_780_000_000_000)
            .expect("recorded");

        assert_eq!(
            cli_session_id_of(&registry, "app-1"),
            Ok(Some("01a06218-e436-7963-827b-6103963b4320".into()))
        );
    }

    /// The meta file the history reader consumes must round-trip through the
    /// exact keys `hq_desktop_core::sessions::claude` deserializes.
    #[test]
    fn session_meta_uses_the_keys_the_history_reader_parses() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        write_session_meta(
            &root,
            "sess-1",
            Some("indigo"),
            SessionTool::Claude,
            None,
            Some("launch"),
        )
        .expect("write");

        let raw = std::fs::read_to_string(root.join("workspace/sessions/sess-1/meta.yaml"))
            .expect("read");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).expect("parse");
        assert_eq!(parsed["company_slug"].as_str(), Some("indigo"));
        // The composer's project pick lands under the key the history reader
        // and the project-links join both parse.
        assert_eq!(parsed["project"].as_str(), Some("launch"));
        assert!(parsed["title"].is_null());
        assert!(
            parsed["started_at"]
                .as_str()
                .is_some_and(|t| t.ends_with('Z')),
            "started_at must be ISO-8601 UTC: {raw}"
        );

        // A company-less session writes a null slug rather than omitting the
        // key, which the reader's `#[serde(default)]` handles either way.
        write_session_meta(
            &root,
            "sess-2",
            Some("   "),
            SessionTool::Claude,
            None,
            Some(" "),
        )
        .expect("write");
        let raw = std::fs::read_to_string(root.join("workspace/sessions/sess-2/meta.yaml"))
            .expect("read");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).expect("parse");
        assert!(
            parsed["company_slug"].is_null(),
            "blank slug is not a company"
        );
        assert!(parsed["project"].is_null(), "blank project is no project");
        assert_eq!(parsed["tool"].as_str(), Some("claude"));
        assert!(
            parsed["cli_session_id"].is_null(),
            "Claude's own id is not known when this file is written"
        );

        // A Codex session records the thread id a resume needs.
        write_session_meta(
            &root,
            "sess-3",
            Some("indigo"),
            SessionTool::Codex,
            Some("01a06218-e436-7963-827b-6103963b4320"),
            None,
        )
        .expect("write");
        let raw = std::fs::read_to_string(root.join("workspace/sessions/sess-3/meta.yaml"))
            .expect("read");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).expect("parse");
        assert_eq!(parsed["tool"].as_str(), Some("codex"));
        assert_eq!(
            parsed["cli_session_id"].as_str(),
            Some("01a06218-e436-7963-827b-6103963b4320")
        );
    }

    /// Binding a project after the fact (HQ created one mid-session) rewrites
    /// only the `project` key: the company, tool and start time — and any key
    /// a newer HQ wrote that this app knows nothing about — survive.
    #[test]
    fn a_late_project_binding_rewrites_only_the_project_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        write_session_meta(
            &root,
            "sess-4",
            Some("indigo"),
            SessionTool::Claude,
            None,
            None,
        )
        .expect("write");
        let path = root.join("workspace/sessions/sess-4/meta.yaml");
        let mut raw = std::fs::read_to_string(&path).expect("read");
        raw.push_str("repo: hq-desktop-app\n");
        std::fs::write(&path, raw).expect("append");

        update_session_meta_project(&root, "sess-4", "draft").expect("update");
        let raw = std::fs::read_to_string(&path).expect("read");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).expect("parse");
        assert_eq!(parsed["project"].as_str(), Some("draft"));
        assert_eq!(parsed["company_slug"].as_str(), Some("indigo"));
        assert_eq!(parsed["tool"].as_str(), Some("claude"));
        assert_eq!(parsed["repo"].as_str(), Some("hq-desktop-app"));
        assert!(parsed["started_at"].as_str().is_some());

        // Rebinding overwrites; a path-shaped id is refused; a missing session
        // is an error rather than a file conjured from nothing.
        update_session_meta_project(&root, "sess-4", "onboarding").expect("rebind");
        let raw = std::fs::read_to_string(&path).expect("read");
        assert!(raw.contains("project: onboarding"), "{raw}");
        assert!(update_session_meta_project(&root, "../sess-4", "x").is_err());
        assert!(update_session_meta_project(&root, "missing", "x").is_err());
    }

    #[test]
    fn a_session_title_is_persisted_without_losing_its_project_binding() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        write_session_meta(
            &root,
            "sess-title",
            Some("indigo"),
            SessionTool::Codex,
            Some("native-title"),
            Some("hq-agent-workspace"),
        )
        .expect("write");

        assert!(
            update_session_meta_title(&root, "sess-title", "Plan agent workspace")
                .expect("title update")
        );
        assert!(
            !update_session_meta_title(&root, "sess-title", "Plan agent workspace")
                .expect("same title")
        );

        let raw = std::fs::read_to_string(root.join("workspace/sessions/sess-title/meta.yaml"))
            .expect("read");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).expect("parse");
        assert_eq!(parsed["title"].as_str(), Some("Plan agent workspace"));
        assert_eq!(parsed["project"].as_str(), Some("hq-agent-workspace"));
        assert_eq!(parsed["company_slug"].as_str(), Some("indigo"));
        assert_eq!(parsed["cli_session_id"].as_str(), Some("native-title"));
    }

    #[test]
    fn claude_init_links_the_native_id_without_losing_session_metadata() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        write_session_meta(
            &root,
            "app-session-1",
            Some("indigo"),
            SessionTool::Claude,
            None,
            Some("session-repairs"),
        )
        .expect("write");

        update_session_meta_cli_session_id(&root, "app-session-1", "claude-native-1")
            .expect("link native id");

        let path = root.join("workspace/sessions/app-session-1/meta.yaml");
        let raw = std::fs::read_to_string(path).expect("read");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).expect("parse");
        assert_eq!(parsed["cli_session_id"].as_str(), Some("claude-native-1"));
        assert_eq!(parsed["company_slug"].as_str(), Some("indigo"));
        assert_eq!(parsed["project"].as_str(), Some("session-repairs"));
        assert_eq!(parsed["tool"].as_str(), Some("claude"));
        assert!(parsed["started_at"].as_str().is_some());
    }

    #[tokio::test]
    async fn binding_a_live_session_updates_the_registry_and_reports_changes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        let session_id = format!("bind-{}", uuid::Uuid::new_v4());
        let spec = SessionSpec {
            session_id: session_id.clone(),
            title: None,
            tool: SessionTool::Claude,
            cwd: "/hq".into(),
            company: Some("indigo".into()),
            project: None,
            model: None,
            effort: None,
            resume: None,
            permission_mode: PermissionMode::Prompt,
        };
        state()
            .lock()
            .await
            .registry
            .insert(LiveSession::new(spec, now_iso()))
            .expect("insert");
        write_session_meta(
            &root,
            &session_id,
            Some("indigo"),
            SessionTool::Claude,
            None,
            None,
        )
        .expect("write");

        assert_eq!(
            bind_session_project(&root, &session_id, "draft").await,
            Ok(true)
        );
        assert_eq!(
            bind_session_project(&root, &session_id, "draft").await,
            Ok(false)
        );
        let bound = live_session_summaries()
            .await
            .into_iter()
            .find(|s| s.session_id == session_id)
            .expect("listed");
        assert_eq!(bound.project.as_deref(), Some("draft"));
        let raw = std::fs::read_to_string(
            root.join("workspace/sessions")
                .join(&session_id)
                .join("meta.yaml"),
        )
        .expect("read");
        assert!(raw.contains("project: draft"), "{raw}");
        assert!(bind_session_project(&root, "nope", "draft").await.is_err());

        state().lock().await.registry.remove(&session_id);
    }

    #[tokio::test]
    async fn sending_to_an_unknown_session_fails_instead_of_silently_dropping() {
        let state = SessionState::default();
        let err = state
            .send("nope", Outbound::Interrupt)
            .expect_err("unknown session");
        assert!(err.contains("not running"), "{err}");
    }

    #[tokio::test]
    async fn closing_a_channel_makes_later_writes_fail_loudly() {
        let mut state = SessionState::default();
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        state.set_channel("s1", tx);
        assert!(state.send("s1", Outbound::Interrupt).is_ok());

        state.close_channel("s1");
        assert!(!state.has_channel("s1"));
        assert!(state.send("s1", Outbound::Interrupt).is_err());
    }
}
