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

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use hq_desktop_core::agent_session::claude_wire::{
    answers_updated_input, allow_response, control_response_line, deny_response, user_message_line,
    user_message_line_with_images,
};
use hq_desktop_core::agent_session::registry::{
    LiveSession, PendingRequest, Replay, SessionRegistry, SessionSummary,
};
use hq_desktop_core::agent_session::types::{
    PermissionDecision, QuestionAnswer, SessionPhase, SessionSpec, SessionTool,
};
use hq_desktop_core::agent_session_flags::ensure_in_app_sessions_allowed;
use hq_desktop_core::claude_launch::check_hq_hooks_ready;
use hq_desktop_core::workspaces::{discover_local_companies, humanize_slug, resolve_hq_folder_path};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex;

use crate::util::logfile::log;

use self::claude::{Outbound, SessionEventSink};

const LOG_TAG: &str = "agent-session";

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

// ─────────────────────────────────────────────────────────────────────────────
// Wire payloads
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanyOption {
    pub slug: String,
    pub display_name: String,
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

    let (entries, _manifest_error) = discover_local_companies(&hq_root);
    let companies = entries
        .into_iter()
        .map(|entry| CompanyOption {
            display_name: entry
                .display_name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| humanize_slug(&entry.slug)),
            slug: entry.slug,
        })
        .collect();

    Ok(Preflight {
        hq_root: hq_root.to_string_lossy().into_owned(),
        hooks_ready: hooks_error.is_none(),
        hooks_error,
        claude_available: tools.claude_cli,
        claude_logged_in: ready.logged_in,
        codex_available: tools.codex_cli,
        companies,
    })
}

/// Start a session and begin driving it.
#[tauri::command]
pub async fn agent_session_start(
    app: tauri::AppHandle,
    spec: SessionSpec,
) -> Result<StartedSession, String> {
    ensure_in_app_sessions_allowed()?;
    if spec.tool != SessionTool::Claude {
        return Err("In-app Codex sessions aren't supported yet — use Claude for now.".into());
    }

    let hq_root = resolve_hq_folder_path()?;
    // The session always runs from the HQ root. Anywhere else is a different
    // Claude Code project, where none of HQ's hooks or policies fire.
    let mut spec = spec;
    spec.cwd = hq_root.to_string_lossy().into_owned();
    if spec.session_id.trim().is_empty() {
        spec.session_id = uuid::Uuid::new_v4().to_string();
    }
    let session_id = spec.session_id.clone();

    let state = state();

    // Reserve the slot BEFORE spawning: refusing after a child is already
    // running would leak a process for the length of the error message.
    {
        let mut guard = state.lock().await;
        if guard.registry.get(&session_id).is_some_and(|s| !s.is_ended()) {
            return Err(format!("Session {session_id} is already running."));
        }
        guard
            .registry
            .insert(LiveSession::new(spec.clone(), now_iso()))?;
    }

    let child = match claude::spawn_claude(&spec, hq_root.clone()).await {
        Ok(child) => child,
        Err(e) => {
            state.lock().await.registry.remove(&session_id);
            return Err(e);
        }
    };

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    state.lock().await.set_channel(&session_id, tx);

    let sink: Arc<dyn SessionEventSink> = Arc::new(claude::AppSink(app));
    tokio::spawn(claude::run_session_loop(
        child,
        session_id.clone(),
        state.clone(),
        sink,
        rx,
    ));

    // Best-effort: the session works without it, but the existing history feed
    // reads it to show the company and the true start time.
    if let Err(e) = write_session_meta(&hq_root, &session_id, spec.company.as_deref()) {
        log(LOG_TAG, &format!("session={session_id} meta write failed: {e}"));
    }

    log(LOG_TAG, &format!("session={session_id} started"));
    Ok(StartedSession { session_id })
}

/// Send a user turn (or steer an in-flight one).
#[tauri::command]
pub async fn agent_session_send(
    app: tauri::AppHandle,
    session_id: String,
    text: String,
    images: Option<Vec<ImageAttachment>>,
) -> Result<(), String> {
    ensure_in_app_sessions_allowed()?;
    let attachments: Vec<(String, String)> = images
        .unwrap_or_default()
        .into_iter()
        .map(|image| (image.media_type, image.base64))
        .collect();
    // Slash commands need no client-side expansion: the CLI executes them from
    // a plain user turn (verified against claude 2.1.247).
    let line = if attachments.is_empty() {
        user_message_line(&text)
    } else {
        user_message_line_with_images(&text, &attachments)
    };

    let state = state();
    let mut guard = state.lock().await;
    guard.send(&session_id, Outbound::Line(line))?;
    if let Some(session) = guard.registry.get_mut(&session_id) {
        if let Some(change) = session.on_user_send(now_iso()) {
            claude::AppSink(app).emit_phase(&session_id, change);
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

    let response = match &decision {
        PermissionDecision::AllowOnce => allow_response(input),
        PermissionDecision::AllowSession => {
            // Session-scoped memory only — never a durable settings edit.
            session.remember_allowed_tool(&tool_name);
            allow_response(input)
        }
        PermissionDecision::Allow { updated_input } => allow_response(updated_input.clone()),
        PermissionDecision::Deny { message } => deny_response(message),
    };

    guard.send(
        &session_id,
        Outbound::Line(control_response_line(&request_id, response)),
    )?;
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

    // `AskUserQuestion` is answered by ALLOWING the tool call with the answers
    // merged into its input, keyed by question text — not by a bespoke reply.
    let updated = answers_updated_input(input, &answers, questions);
    guard.send(
        &session_id,
        Outbound::Line(control_response_line(&request_id, allow_response(updated))),
    )?;
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
                log(LOG_TAG, &format!("session={session_id} end not delivered: {e}"));
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

/// The CLI's slash-command catalog and model list, for the composer.
#[tauri::command]
pub async fn agent_session_slash_commands(
    tool: SessionTool,
) -> Result<claude::CommandCatalog, String> {
    ensure_in_app_sessions_allowed()?;
    if tool != SessionTool::Claude {
        return Err("Only Claude exposes a command catalog today.".into());
    }
    let hq_root = resolve_hq_folder_path()?;
    claude::probe_command_catalog(hq_root).await
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
) -> Result<(), String> {
    let dir = hq_root.join("workspace").join("sessions").join(session_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let meta = SessionMetaOut {
        company_slug: company
            .map(str::trim)
            .filter(|slug| !slug.is_empty())
            .map(str::to_owned),
        started_at: now_iso(),
    };
    let yaml = serde_yaml::to_string(&meta).map_err(|e| format!("serialize meta: {e}"))?;
    std::fs::write(dir.join("meta.yaml"), yaml).map_err(|e| format!("write meta.yaml: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// The meta file the history reader consumes must round-trip through the
    /// exact keys `hq_desktop_core::sessions::claude` deserializes.
    #[test]
    fn session_meta_uses_the_keys_the_history_reader_parses() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        write_session_meta(&root, "sess-1", Some("indigo")).expect("write");

        let raw = std::fs::read_to_string(root.join("workspace/sessions/sess-1/meta.yaml"))
            .expect("read");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).expect("parse");
        assert_eq!(parsed["company_slug"].as_str(), Some("indigo"));
        assert!(
            parsed["started_at"].as_str().is_some_and(|t| t.ends_with('Z')),
            "started_at must be ISO-8601 UTC: {raw}"
        );

        // A company-less session writes a null slug rather than omitting the
        // key, which the reader's `#[serde(default)]` handles either way.
        write_session_meta(&root, "sess-2", Some("   ")).expect("write");
        let raw = std::fs::read_to_string(root.join("workspace/sessions/sess-2/meta.yaml"))
            .expect("read");
        let parsed: serde_yaml::Value = serde_yaml::from_str(&raw).expect("parse");
        assert!(parsed["company_slug"].is_null(), "blank slug is not a company");
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
