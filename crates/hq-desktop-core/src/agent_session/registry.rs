//! The live-session model: what the app knows about the agent sessions that
//! are running *right now*.
//!
//! Pure and synchronous — no process, no Tauri, no I/O. The driver owns the
//! child process and the event emission; this module owns the state that
//! decides what those emissions mean:
//!
//! * [`EventRing`] — the bounded replay buffer behind
//!   `agent_session_replay`. A UI that was closed, reloaded, or opened late
//!   catches up from it instead of from the child (which cannot replay).
//! * [`LiveSession`] — one running session: its phase, its parked requests,
//!   its session-scoped tool allowlist, its buffer.
//! * [`SessionRegistry`] — the small, capped set of them.
//!
//! # Why the phase machine lives here and not in the UI
//!
//! `NeedsYou` is the whole product: a session that is blocked on a human and
//! says nothing is indistinguishable from a session that is thinking. The
//! transition is derived from the event stream in one place so the tray badge,
//! the session list, and the transcript can never disagree about it.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::types::{
    PermissionMode, Question, SessionEvent, SessionPhase, SessionSpec, SessionTool,
};
use crate::stdio::SlotCircuit;

// ─────────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum events retained per session for replay.
pub const RING_MAX_EVENTS: usize = 4_000;

/// Maximum serialized bytes retained per session for replay. A transcript full
/// of large tool results hits this long before the count bound, which is
/// exactly why both exist: 4 000 × a 2 MB `ToolResult` is not a bounded buffer.
pub const RING_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Maximum concurrently non-`Ended` sessions. Each one is a `claude` process
/// with its own MCP servers; four is already a lot of RAM on a laptop.
pub const MAX_LIVE_SESSIONS: usize = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Event ring
// ─────────────────────────────────────────────────────────────────────────────

struct RingEntry {
    seq: u64,
    /// Unix milliseconds the event was recorded, supplied by the caller (this
    /// module stays clock-free). Stored per entry rather than derived at
    /// replay because a replayed transcript's only honest time is the one it
    /// was stamped with when it arrived.
    received_at_ms: u64,
    event: SessionEvent,
    /// Serialized size, measured once at push. Measuring on eviction instead
    /// would let a re-serialization difference drift the running total.
    size: usize,
}

/// One replayed event: its seq, when it arrived, and the event itself.
///
/// A struct rather than the tuple this used to be, because a positional
/// `(seq, receivedAtMs, event)` triple on the wire is exactly the shape a
/// TypeScript consumer mis-destructures silently.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayEntry {
    pub seq: u64,
    pub received_at_ms: u64,
    pub event: SessionEvent,
}

/// Outcome of [`EventRing::push`].
#[derive(Debug, Clone, PartialEq)]
pub struct Pushed {
    /// The sequence number assigned to the pushed event.
    pub seq: u64,
    /// The stamp the event was recorded with, echoed back so a caller emits
    /// the same instant it buffered rather than reading the clock twice.
    pub received_at_ms: u64,
    /// Present when this push evicted older events. Carries the CUMULATIVE
    /// drop count for the session, so a consumer that missed an earlier marker
    /// still learns the true total.
    pub truncated: Option<SessionEvent>,
}

/// Result of [`EventRing::replay`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    /// Entries with `seq >= since_seq`, oldest first. When `truncated` is set
    /// the first entry is a [`SessionEvent::Truncated`] marker standing in for
    /// the dropped span.
    pub events: Vec<ReplayEntry>,
    /// The seq to pass as `since_seq` next time. Contiguous by construction:
    /// `replay(0)` then `replay(next_seq)` never repeats or skips an event.
    pub next_seq: u64,
    /// True when events before `since_seq`'s window were dropped, i.e. the
    /// caller cannot reconstruct a complete transcript from this buffer.
    pub truncated: bool,
}

/// A bounded, seq-addressed replay buffer for one session's events.
///
/// Bounded twice — by count and by serialized bytes — and drop-oldest, because
/// the newest events are what a reconnecting UI needs and the oldest are what
/// it can most cheaply live without.
///
/// The truncation marker is deliberately NOT stored as an entry. Storing it
/// would make it compete with real events for the very bounds it exists to
/// report, and evicting a marker to make room for another marker is a loop
/// waiting to happen. It is held beside the deque and materialized at replay.
pub struct EventRing {
    entries: VecDeque<RingEntry>,
    bytes: usize,
    next_seq: u64,
    max_events: usize,
    max_bytes: usize,
    /// `(seq of the last dropped event, its stamp, cumulative dropped)`.
    /// `None` until the first eviction. The stamp is carried so the
    /// materialized marker is dated by the span it stands in for rather than
    /// by the moment someone happened to ask for a replay.
    truncation: Option<(u64, u64, u64)>,
}

impl Default for EventRing {
    fn default() -> Self {
        Self::new()
    }
}

impl EventRing {
    pub fn new() -> Self {
        Self::with_bounds(RING_MAX_EVENTS, RING_MAX_BYTES)
    }

    /// [`EventRing::new`] with caller-chosen bounds. Exists so a test can
    /// prove wrap behaviour without pushing four thousand events or eight
    /// megabytes through it.
    pub fn with_bounds(max_events: usize, max_bytes: usize) -> Self {
        Self {
            entries: VecDeque::new(),
            bytes: 0,
            next_seq: 0,
            max_events: max_events.max(1),
            max_bytes: max_bytes.max(1),
            truncation: None,
        }
    }

    /// Number of retained events.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Retained serialized bytes.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// The seq the next pushed event will get.
    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    /// The seq of the most recently pushed event, or 0 before the first push.
    pub fn last_seq(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }

    /// Total events dropped by eviction so far.
    pub fn dropped(&self) -> u64 {
        self.truncation.map(|(_, _, dropped)| dropped).unwrap_or(0)
    }

    /// Append one event stamped with `received_at_ms` (unix ms), evicting from
    /// the front until both bounds hold.
    pub fn push(&mut self, event: SessionEvent, received_at_ms: u64) -> Pushed {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        let size = serialized_size(&event);
        self.entries.push_back(RingEntry {
            seq,
            received_at_ms,
            event,
            size,
        });
        self.bytes = self.bytes.saturating_add(size);
        Pushed {
            seq,
            received_at_ms,
            truncated: self.evict(),
        }
    }

    /// Drop from the front until both bounds hold. Never evicts the last
    /// entry: a single event larger than `max_bytes` is retained rather than
    /// leaving an empty buffer that reports nothing at all.
    fn evict(&mut self) -> Option<SessionEvent> {
        let mut dropped = 0u64;
        let mut last_dropped_seq = 0u64;
        let mut last_dropped_at = 0u64;
        while self.entries.len() > self.max_events
            || (self.bytes > self.max_bytes && self.entries.len() > 1)
        {
            let Some(front) = self.entries.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(front.size);
            last_dropped_seq = front.seq;
            last_dropped_at = front.received_at_ms;
            dropped += 1;
        }
        if dropped == 0 {
            return None;
        }
        let total = self.dropped().saturating_add(dropped);
        self.truncation = Some((last_dropped_seq, last_dropped_at, total));
        Some(SessionEvent::Truncated { dropped: total })
    }

    /// Everything with `seq >= since_seq`, plus the cursor to continue from.
    pub fn replay(&self, since_seq: u64) -> Replay {
        let truncated =
            matches!(self.truncation, Some((marker_seq, _, _)) if since_seq <= marker_seq);
        let mut events: Vec<ReplayEntry> = Vec::new();
        if let (true, Some((marker_seq, marker_at, dropped))) = (truncated, self.truncation) {
            events.push(ReplayEntry {
                seq: marker_seq,
                received_at_ms: marker_at,
                event: SessionEvent::Truncated { dropped },
            });
        }
        events.extend(self.entries.iter().filter(|entry| entry.seq >= since_seq).map(
            |entry| ReplayEntry {
                seq: entry.seq,
                received_at_ms: entry.received_at_ms,
                event: entry.event.clone(),
            },
        ));
        Replay {
            events,
            next_seq: self.next_seq,
            truncated,
        }
    }
}

/// Serialized JSON length of an event — the same bytes the ring is bounded in
/// and the same bytes the IPC layer will ship, so the bound means what it says.
fn serialized_size(event: &SessionEvent) -> usize {
    serde_json::to_string(event).map(|s| s.len()).unwrap_or(0)
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending requests
// ─────────────────────────────────────────────────────────────────────────────

/// A CLI control request the session is parked on, keyed by its `request_id`.
///
/// The input is kept because the allow payload has to echo it back (possibly
/// rewritten), and the questions because the answers are merged into the
/// original `AskUserQuestion` input by question TEXT — which the client would
/// otherwise have to be trusted to round-trip correctly.
#[derive(Debug, Clone, PartialEq)]
pub enum PendingRequest {
    Permission {
        tool_name: String,
        input: Value,
    },
    Question {
        questions: Vec<Question>,
        /// The verbatim `AskUserQuestion` tool input. Starts `Null` — the
        /// normalized [`SessionEvent::QuestionRequest`] deliberately carries
        /// only the rendered questions, so the driver, which does see the raw
        /// control request, fills this in with
        /// [`LiveSession::set_pending_question_input`]. The allow payload has
        /// to echo the original input with `answers` merged in, and rebuilding
        /// it from the parsed questions would silently drop any field this
        /// version of the CLI sends and we do not model.
        input: Value,
    },
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase machine
// ─────────────────────────────────────────────────────────────────────────────

/// A phase transition worth telling the UI about. Only emitted when the phase
/// actually changed, so a listener can treat every one as an edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseChange {
    pub from: SessionPhase,
    pub to: SessionPhase,
}

/// Why a session is blocked on the human, and what on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsYou {
    /// `permission` or `question`.
    pub reason: String,
    /// One line for a notification: the tool name, or the first question header.
    pub summary: String,
    pub request_id: String,
}

/// What [`LiveSession::on_event`] decided about one event.
#[derive(Debug, Clone, PartialEq)]
pub struct EventOutcome {
    pub seq: u64,
    /// The stamp the event was buffered with — the same instant a live
    /// emission must carry, so a listener and a later replay agree.
    pub received_at_ms: u64,
    pub phase_change: Option<PhaseChange>,
    pub needs_you: Option<NeedsYou>,
    /// Set when recording this event evicted older ones.
    pub truncated: Option<SessionEvent>,
}

/// What the permission policy says about a `can_use_tool` request, BEFORE the
/// user is ever shown anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoDecision {
    /// Answer `allow` immediately; do not surface a prompt.
    Allow,
    /// Park it and ask the human.
    Ask,
}

// ─────────────────────────────────────────────────────────────────────────────
// Live session
// ─────────────────────────────────────────────────────────────────────────────

/// One agent session the app is currently driving.
pub struct LiveSession {
    pub spec: SessionSpec,
    pub phase: SessionPhase,
    /// Tool names the user chose "allow for this session" on. Client-side
    /// memory on purpose: the CLI's own `permission_suggestions` write durable
    /// settings, and a checkbox in a chat window must not edit the user's
    /// `.claude/settings.json`.
    pub allow_session: HashSet<String>,
    /// Parked control requests by `request_id`.
    pub pending: HashMap<String, PendingRequest>,
    pub buffer: EventRing,
    pub circuit: SlotCircuit,
    /// ISO-8601 UTC.
    pub started_at: String,
    /// ISO-8601 UTC, bumped on every recorded event.
    pub last_activity_at: String,
    /// True between our interrupt request and the `result` that answers it.
    pub interrupted: bool,
    /// Model reported by the CLI's `init` frame; falls back to the spec's.
    pub model: Option<String>,
    /// The CLI's own session id, once `init` reported it (equals the spec id on
    /// a fresh run; differs on a resume).
    pub cli_session_id: Option<String>,
    /// Latched by the first `Exited` so a second one cannot double-report.
    ended: bool,
}

impl LiveSession {
    /// A session in [`SessionPhase::Starting`], before its child has said
    /// anything. `now` is an ISO-8601 UTC timestamp supplied by the caller so
    /// this module stays clock-free and testable.
    pub fn new(spec: SessionSpec, now: String) -> Self {
        Self {
            model: spec.model.clone(),
            spec,
            phase: SessionPhase::Starting,
            allow_session: HashSet::new(),
            pending: HashMap::new(),
            buffer: EventRing::new(),
            circuit: SlotCircuit::new(),
            started_at: now.clone(),
            last_activity_at: now,
            interrupted: false,
            cli_session_id: None,
            ended: false,
        }
    }

    pub fn session_id(&self) -> &str {
        &self.spec.session_id
    }

    pub fn is_ended(&self) -> bool {
        self.ended
    }

    /// The seq the next recorded event will get.
    pub fn next_seq(&self) -> u64 {
        self.buffer.next_seq()
    }

    fn transition(&mut self, to: SessionPhase) -> Option<PhaseChange> {
        // Ended is terminal: a late frame from a dying child must not resurrect
        // a session the UI has already retired.
        if self.phase == to || self.phase == SessionPhase::Ended {
            return None;
        }
        let from = self.phase;
        self.phase = to;
        Some(PhaseChange { from, to })
    }

    /// Record one normalized event: buffer it, advance the phase, and report
    /// whether a human is now needed. `received_at_ms` is unix milliseconds,
    /// supplied by the caller so this module stays clock-free.
    ///
    /// `None` means the event was suppressed — today only a second
    /// [`SessionEvent::Exited`], which must never be recorded twice (the read
    /// loop's EOF branch and the reaper can both observe the same exit).
    pub fn on_event(
        &mut self,
        event: SessionEvent,
        now: String,
        received_at_ms: u64,
    ) -> Option<EventOutcome> {
        if self.ended && matches!(event, SessionEvent::Exited { .. }) {
            return None;
        }
        self.last_activity_at = now;

        let mut needs_you = None;
        let mut phase_target = None;

        match &event {
            SessionEvent::Started { session_id, model, .. } => {
                if !session_id.is_empty() {
                    self.cli_session_id = Some(session_id.clone());
                }
                if !model.is_empty() {
                    self.model = Some(model.clone());
                }
                phase_target = Some(SessionPhase::Idle);
            }
            SessionEvent::PermissionRequest {
                request_id,
                tool_name,
                input,
                ..
            } => {
                self.pending.insert(
                    request_id.clone(),
                    PendingRequest::Permission {
                        tool_name: tool_name.clone(),
                        input: input.clone(),
                    },
                );
                needs_you = Some(NeedsYou {
                    reason: "permission".into(),
                    summary: tool_name.clone(),
                    request_id: request_id.clone(),
                });
                phase_target = Some(SessionPhase::NeedsYou);
            }
            SessionEvent::QuestionRequest {
                request_id,
                questions,
            } => {
                self.pending.insert(
                    request_id.clone(),
                    PendingRequest::Question {
                        questions: questions.clone(),
                        input: Value::Null,
                    },
                );
                needs_you = Some(NeedsYou {
                    reason: "question".into(),
                    summary: questions
                        .first()
                        .map(|q| q.header.clone())
                        .unwrap_or_else(|| "Question".into()),
                    request_id: request_id.clone(),
                });
                phase_target = Some(SessionPhase::NeedsYou);
            }
            SessionEvent::TurnDone { .. } => {
                self.interrupted = false;
                // A turn cannot end while a request is parked; if one somehow
                // is, the CLI abandoned it and so do we.
                self.pending.clear();
                phase_target = Some(SessionPhase::Idle);
            }
            SessionEvent::Exited { .. } => {
                self.ended = true;
                self.pending.clear();
                phase_target = Some(SessionPhase::Ended);
            }
            // Text, tools, usage, rate limits, and errors are transcript
            // content: they say the session is alive, not that it changed
            // state. A mid-turn `Error` is followed by a `result`.
            _ => {}
        }

        // Buffer AFTER the phase bookkeeping but BEFORE returning, so `seq` and
        // the phase edge describe the same event.
        let pushed = self.buffer.push(event, received_at_ms);
        let phase_change = phase_target.and_then(|target| self.transition(target));
        Some(EventOutcome {
            seq: pushed.seq,
            received_at_ms: pushed.received_at_ms,
            phase_change,
            needs_you,
            truncated: pushed.truncated,
        })
    }

    /// The user sent a turn (or a steer). Not derived from an event because
    /// nothing on the wire acknowledges a user line — the CLI simply starts
    /// working — and a composer that stays `Idle` until the first token looks
    /// broken.
    pub fn on_user_send(&mut self, now: String) -> Option<PhaseChange> {
        self.last_activity_at = now;
        self.transition(SessionPhase::Working)
    }

    /// A parked request was answered. Drops it and, once nothing else is
    /// parked, returns to `Working` — the CLI resumes the turn the moment the
    /// control response lands.
    pub fn on_response_sent(&mut self, request_id: &str, now: String) -> Option<PhaseChange> {
        self.last_activity_at = now;
        self.pending.remove(request_id);
        if self.pending.is_empty() {
            self.transition(SessionPhase::Working)
        } else {
            None
        }
    }

    /// Remember a tool for the rest of the session (the `allowSession` choice).
    pub fn remember_allowed_tool(&mut self, tool_name: &str) {
        self.allow_session.insert(tool_name.to_owned());
    }

    /// Attach the verbatim `AskUserQuestion` tool input to a parked question.
    /// Called by the driver immediately after recording the event, because the
    /// raw input exists only on the control request, not on the normalized
    /// event. No-op when the request id is not a parked question.
    pub fn set_pending_question_input(&mut self, request_id: &str, raw_input: Value) {
        if let Some(PendingRequest::Question { input, .. }) = self.pending.get_mut(request_id) {
            *input = raw_input;
        }
    }

    pub fn summary(&self) -> SessionSummary {
        SessionSummary {
            session_id: self.spec.session_id.clone(),
            tool: self.spec.tool,
            phase: self.phase,
            company: self.spec.company.clone(),
            model: self.model.clone(),
            effort: self.spec.effort.clone(),
            permission_mode: self.spec.permission_mode,
            cwd: self.spec.cwd.clone(),
            started_at: self.started_at.clone(),
            last_activity_at: self.last_activity_at.clone(),
            last_seq: self.buffer.last_seq(),
            pending_count: self.pending.len(),
        }
    }
}

/// Should this `can_use_tool` request be auto-allowed?
///
/// Three rules, in order:
/// 1. `bypassAll` allows everything — the user already accepted that when they
///    chose the mode, and the CLI itself would not have asked.
/// 2. A tool the user allowed for this session allows without asking again.
/// 3. Otherwise, ask.
///
/// Note what is NOT here: the CLI's `permission_suggestions`. Acting on them
/// would let a chat window write durable permission rules into the user's
/// settings; a session-scoped decision must stay session-scoped.
pub fn decide_can_use_tool(session: &LiveSession, tool_name: &str) -> AutoDecision {
    if session.spec.permission_mode == PermissionMode::BypassAll {
        return AutoDecision::Allow;
    }
    if session.allow_session.contains(tool_name) {
        return AutoDecision::Allow;
    }
    AutoDecision::Ask
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

/// One row of the session list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub tool: SessionTool,
    pub phase: SessionPhase,
    pub company: Option<String>,
    pub model: Option<String>,
    /// The reasoning effort the session was launched with, when one was chosen.
    pub effort: Option<String>,
    /// How this session answers tool-permission requests.
    pub permission_mode: PermissionMode,
    pub cwd: String,
    pub started_at: String,
    pub last_activity_at: String,
    pub last_seq: u64,
    pub pending_count: usize,
}

/// Every session the app is driving, capped at [`MAX_LIVE_SESSIONS`] live ones.
///
/// `Ended` sessions stay addressable (their transcript is still replayable)
/// but stop counting against the cap — otherwise a user who never closed four
/// finished chats could not start a fifth.
pub struct SessionRegistry {
    sessions: HashMap<String, LiveSession>,
    max_live: usize,
}

/// Deliberately hand-written: a derived `Default` would give `max_live = 0`,
/// which reads as "no sessions allowed at all" and is exactly the kind of
/// silent zero a `#[derive]` makes easy to ship.
impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::with_max_live(MAX_LIVE_SESSIONS)
    }

    pub fn with_max_live(max_live: usize) -> Self {
        Self {
            sessions: HashMap::new(),
            max_live,
        }
    }

    /// Number of sessions that are not `Ended`.
    pub fn live_count(&self) -> usize {
        self.sessions
            .values()
            .filter(|s| s.phase != SessionPhase::Ended)
            .count()
    }

    /// Admit a session, or refuse when the live cap is already reached.
    /// Replacing an existing id is allowed (a resume of the same session).
    pub fn insert(&mut self, session: LiveSession) -> Result<(), String> {
        let id = session.spec.session_id.clone();
        let replacing = self.sessions.contains_key(&id);
        if !replacing && self.live_count() >= self.max_live {
            return Err(format!(
                "Too many live sessions ({} of {}). End one before starting another.",
                self.live_count(),
                self.max_live
            ));
        }
        self.sessions.insert(id, session);
        Ok(())
    }

    pub fn get(&self, session_id: &str) -> Option<&LiveSession> {
        self.sessions.get(session_id)
    }

    pub fn get_mut(&mut self, session_id: &str) -> Option<&mut LiveSession> {
        self.sessions.get_mut(session_id)
    }

    pub fn remove(&mut self, session_id: &str) -> Option<LiveSession> {
        self.sessions.remove(session_id)
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions.contains_key(session_id)
    }

    /// The session list, newest-started first so the UI order is stable across
    /// calls (a `HashMap` iteration order is not).
    pub fn snapshot(&self) -> Vec<SessionSummary> {
        let mut rows: Vec<SessionSummary> = self.sessions.values().map(LiveSession::summary).collect();
        rows.sort_by(|a, b| {
            b.started_at
                .cmp(&a.started_at)
                .then_with(|| a.session_id.cmp(&b.session_id))
        });
        rows
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_session::types::{DoneStatus, QuestionOption};
    use serde_json::json;

    fn spec(id: &str, mode: PermissionMode) -> SessionSpec {
        SessionSpec {
            session_id: id.into(),
            tool: SessionTool::Claude,
            cwd: "/hq".into(),
            company: Some("indigo".into()),
            model: Some("haiku".into()),
            effort: None,
            resume: None,
            permission_mode: mode,
        }
    }

    fn session(id: &str) -> LiveSession {
        LiveSession::new(spec(id, PermissionMode::Prompt), "2026-09-01T00:00:00Z".into())
    }

    fn now() -> String {
        "2026-09-01T00:00:01Z".into()
    }

    /// A fixed wall clock for the tests. `ms(n)` is distinguishable per event
    /// so an assertion about WHICH event's stamp survived is meaningful.
    const T0: u64 = 1_780_000_000_000;

    fn ms(n: u64) -> u64 {
        T0 + n
    }

    fn now_ms() -> u64 {
        T0
    }

    fn text(body: &str) -> SessionEvent {
        SessionEvent::TextDelta {
            text: body.into(),
            parent_tool_use_id: None,
        }
    }

    fn started() -> SessionEvent {
        SessionEvent::Started {
            session_id: "cli-1".into(),
            tool: SessionTool::Claude,
            model: "claude-haiku-4-5".into(),
            cwd: "/hq".into(),
            tools: vec!["Bash".into()],
            commands: vec![],
            permission_mode: Some("default".into()),
            capabilities: vec![],
        }
    }

    fn permission(request_id: &str, tool: &str) -> SessionEvent {
        SessionEvent::PermissionRequest {
            request_id: request_id.into(),
            tool_name: tool.into(),
            input: json!({"file_path": "/tmp/x"}),
            suggestions: json!([]),
        }
    }

    fn turn_done() -> SessionEvent {
        SessionEvent::TurnDone {
            status: DoneStatus::Success,
            error: None,
            session_id: Some("cli-1".into()),
        }
    }

    // ── ring ────────────────────────────────────────────────────────────────

    #[test]
    fn the_ring_wraps_on_the_count_bound_and_records_a_truncation_marker() {
        let mut ring = EventRing::with_bounds(3, RING_MAX_BYTES);
        for i in 0..3 {
            assert!(ring.push(text(&format!("t{i}")), ms(i)).truncated.is_none());
        }
        assert_eq!(ring.len(), 3);

        let pushed = ring.push(text("t3"), ms(3));
        assert_eq!(pushed.seq, 3);
        assert_eq!(
            pushed.truncated,
            Some(SessionEvent::Truncated { dropped: 1 }),
            "the first eviction reports one dropped event"
        );
        assert_eq!(ring.len(), 3, "the count bound is never exceeded");
        assert_eq!(ring.dropped(), 1);

        // The marker accumulates rather than resetting.
        let pushed = ring.push(text("t4"), ms(4));
        assert_eq!(pushed.truncated, Some(SessionEvent::Truncated { dropped: 2 }));
        assert_eq!(ring.dropped(), 2);
    }

    #[test]
    fn the_ring_wraps_on_the_byte_bound_too() {
        // One event is ~50 bytes serialized; a 200-byte cap holds a handful.
        let mut ring = EventRing::with_bounds(10_000, 200);
        for i in 0..40 {
            ring.push(text(&format!("payload-{i}")), ms(i));
        }
        assert!(
            ring.bytes() <= 200,
            "byte bound held: {} bytes retained",
            ring.bytes()
        );
        assert!(ring.len() < 40, "the byte bound evicted before the count bound");
        assert!(ring.dropped() > 0);
    }

    #[test]
    fn the_ring_keeps_one_event_even_when_it_alone_exceeds_the_byte_bound() {
        let mut ring = EventRing::with_bounds(10, 8);
        ring.push(text(&"x".repeat(500)), ms(0));
        assert_eq!(ring.len(), 1, "an over-large event is retained, not dropped to nothing");
        assert_eq!(ring.replay(0).events.len(), 1);
    }

    #[test]
    fn replay_is_contiguous_across_successive_cursors() {
        let mut ring = EventRing::new();
        for i in 0..10 {
            ring.push(text(&format!("t{i}")), ms(i));
        }
        let first = ring.replay(0);
        assert_eq!(first.events.len(), 10);
        assert!(!first.truncated);
        assert_eq!(first.next_seq, 10);
        assert_eq!(first.events[0].seq, 0);
        assert_eq!(first.events[0].received_at_ms, ms(0), "the stamp travels with the event");

        for i in 10..15 {
            ring.push(text(&format!("t{i}")), ms(i));
        }
        let second = ring.replay(first.next_seq);
        assert_eq!(second.next_seq, 15);
        assert!(!second.truncated);
        let seqs: Vec<u64> = second.events.iter().map(|entry| entry.seq).collect();
        assert_eq!(seqs, vec![10, 11, 12, 13, 14], "no gap, no repeat");
    }

    #[test]
    fn replay_reports_truncation_only_to_callers_whose_cursor_fell_off_the_back() {
        let mut ring = EventRing::with_bounds(3, RING_MAX_BYTES);
        for i in 0..6 {
            ring.push(text(&format!("t{i}")), ms(i));
        }
        // Retained: seqs 3,4,5. Dropped: 0,1,2 (marker seq 2, dropped 3).
        let full = ring.replay(0);
        assert!(full.truncated);
        assert_eq!(
            full.events[0],
            ReplayEntry {
                seq: 2,
                received_at_ms: ms(2),
                event: SessionEvent::Truncated { dropped: 3 },
            },
            "the gap is materialized in-band, at the last dropped seq and its stamp"
        );
        let seqs: Vec<u64> = full.events.iter().map(|entry| entry.seq).collect();
        assert_eq!(seqs, vec![2, 3, 4, 5], "monotonic even with the marker");

        let caught_up = ring.replay(3);
        assert!(!caught_up.truncated, "a cursor inside the window lost nothing");
        assert_eq!(caught_up.events.len(), 3);
    }

    // ── phase machine ───────────────────────────────────────────────────────

    #[test]
    fn the_phase_machine_runs_start_to_needs_you_to_idle() {
        let mut s = session("s1");
        assert_eq!(s.phase, SessionPhase::Starting);

        let out = s.on_event(started(), now(), now_ms()).expect("recorded");
        assert_eq!(
            out.phase_change,
            Some(PhaseChange {
                from: SessionPhase::Starting,
                to: SessionPhase::Idle
            })
        );
        assert_eq!(s.cli_session_id.as_deref(), Some("cli-1"));
        assert_eq!(s.model.as_deref(), Some("claude-haiku-4-5"));

        assert_eq!(
            s.on_user_send(now()),
            Some(PhaseChange {
                from: SessionPhase::Idle,
                to: SessionPhase::Working
            })
        );

        // Text does not move the phase.
        let out = s.on_event(text("hi"), now(), now_ms()).expect("recorded");
        assert_eq!(out.phase_change, None);
        assert_eq!(s.phase, SessionPhase::Working);

        let out = s.on_event(permission("req_1", "Write"), now(), now_ms()).expect("recorded");
        assert_eq!(
            out.phase_change,
            Some(PhaseChange {
                from: SessionPhase::Working,
                to: SessionPhase::NeedsYou
            })
        );
        let needs = out.needs_you.expect("needs-you");
        assert_eq!(needs.reason, "permission");
        assert_eq!(needs.summary, "Write");
        assert_eq!(needs.request_id, "req_1");
        assert_eq!(s.pending.len(), 1);

        assert_eq!(
            s.on_response_sent("req_1", now()),
            Some(PhaseChange {
                from: SessionPhase::NeedsYou,
                to: SessionPhase::Working
            })
        );
        assert!(s.pending.is_empty());

        let out = s.on_event(turn_done(), now(), now_ms()).expect("recorded");
        assert_eq!(
            out.phase_change,
            Some(PhaseChange {
                from: SessionPhase::Working,
                to: SessionPhase::Idle
            })
        );
    }

    #[test]
    fn a_second_parked_request_keeps_the_session_needing_you() {
        let mut s = session("s1");
        s.on_event(started(), now(), now_ms());
        s.on_user_send(now());
        s.on_event(permission("req_1", "Write"), now(), now_ms());
        s.on_event(permission("req_2", "Bash"), now(), now_ms());
        assert_eq!(s.pending.len(), 2);

        assert_eq!(
            s.on_response_sent("req_1", now()),
            None,
            "one request still parked — stay in NeedsYou"
        );
        assert_eq!(s.phase, SessionPhase::NeedsYou);
        assert!(s.on_response_sent("req_2", now()).is_some());
        assert_eq!(s.phase, SessionPhase::Working);
    }

    #[test]
    fn a_question_request_parks_with_its_header_as_the_summary() {
        let mut s = session("s1");
        s.on_event(started(), now(), now_ms());
        let out = s
            .on_event(
                SessionEvent::QuestionRequest {
                    request_id: "req_q".into(),
                    questions: vec![Question {
                        id: "q0".into(),
                        header: "Colour".into(),
                        text: "Pick a colour".into(),
                        options: vec![QuestionOption {
                            label: "Blue".into(),
                            description: None,
                        }],
                        multi_select: false,
                    }],
                },
                now(),
                now_ms(),
            )
            .expect("recorded");
        let needs = out.needs_you.expect("needs-you");
        assert_eq!(needs.reason, "question");
        assert_eq!(needs.summary, "Colour");
        assert_eq!(s.phase, SessionPhase::NeedsYou);
        assert!(matches!(
            s.pending.get("req_q"),
            Some(PendingRequest::Question { questions, input })
                if questions.len() == 1 && input.is_null()
        ));

        // The driver back-fills the raw tool input the allow payload must echo.
        s.set_pending_question_input("req_q", json!({"questions": [{"question": "Pick a colour"}]}));
        assert!(matches!(
            s.pending.get("req_q"),
            Some(PendingRequest::Question { input, .. }) if input["questions"].is_array()
        ));
        s.set_pending_question_input("nope", json!({"x": 1}));
    }

    #[test]
    fn exit_drops_pendings_and_is_recorded_exactly_once() {
        let mut s = session("s1");
        s.on_event(started(), now(), now_ms());
        s.on_user_send(now());
        s.on_event(permission("req_1", "Write"), now(), now_ms());
        assert_eq!(s.pending.len(), 1);

        let out = s
            .on_event(
                SessionEvent::Exited {
                    code: Some(0),
                    signal: None,
                },
                now(),
                now_ms(),
            )
            .expect("first exit is recorded");
        assert_eq!(
            out.phase_change,
            Some(PhaseChange {
                from: SessionPhase::NeedsYou,
                to: SessionPhase::Ended
            })
        );
        assert!(s.pending.is_empty(), "a dead child answers nothing");
        assert!(s.is_ended());

        assert!(
            s.on_event(
                SessionEvent::Exited {
                    code: Some(1),
                    signal: None
                },
                now(),
                now_ms()
            )
            .is_none(),
            "a second exit is suppressed"
        );
        let exits = s
            .buffer
            .replay(0)
            .events
            .into_iter()
            .filter(|entry| matches!(entry.event, SessionEvent::Exited { .. }))
            .count();
        assert_eq!(exits, 1, "exactly one Exited in the transcript");
    }

    #[test]
    fn ended_is_terminal_for_later_frames() {
        let mut s = session("s1");
        s.on_event(started(), now(), now_ms());
        s.on_event(
            SessionEvent::Exited {
                code: Some(0),
                signal: None,
            },
            now(),
            now_ms(),
        );
        let out = s.on_event(turn_done(), now(), now_ms()).expect("still buffered");
        assert_eq!(out.phase_change, None);
        assert_eq!(s.phase, SessionPhase::Ended);
        assert_eq!(s.on_user_send(now()), None);
    }

    // ── permission policy ───────────────────────────────────────────────────

    #[test]
    fn the_permission_policy_asks_by_default_and_short_circuits_on_allow_session() {
        let mut s = session("s1");
        assert_eq!(decide_can_use_tool(&s, "Write"), AutoDecision::Ask);
        s.remember_allowed_tool("Write");
        assert_eq!(decide_can_use_tool(&s, "Write"), AutoDecision::Allow);
        assert_eq!(
            decide_can_use_tool(&s, "Bash"),
            AutoDecision::Ask,
            "remembering one tool must not remember another"
        );
    }

    #[test]
    fn bypass_all_allows_every_tool_without_remembering_anything() {
        let s = LiveSession::new(
            spec("s1", PermissionMode::BypassAll),
            "2026-09-01T00:00:00Z".into(),
        );
        assert_eq!(decide_can_use_tool(&s, "Write"), AutoDecision::Allow);
        assert_eq!(decide_can_use_tool(&s, "AnythingElse"), AutoDecision::Allow);
        assert!(s.allow_session.is_empty());
    }

    // ── registry ────────────────────────────────────────────────────────────

    #[test]
    fn a_default_registry_admits_sessions_rather_than_refusing_every_one() {
        // A derived Default would set max_live = 0 and make every insert fail.
        let mut registry = SessionRegistry::default();
        registry.insert(session("s1")).expect("default registry admits");
        assert_eq!(registry.live_count(), 1);
    }

    #[test]
    fn the_registry_caps_live_sessions_and_frees_the_slot_when_one_ends() {
        let mut registry = SessionRegistry::with_max_live(2);
        registry.insert(session("s1")).expect("first");
        registry.insert(session("s2")).expect("second");
        let err = registry.insert(session("s3")).expect_err("over the cap");
        assert!(err.contains("Too many live sessions"), "{err}");

        // Ending one frees a slot.
        registry
            .get_mut("s1")
            .unwrap()
            .on_event(
                SessionEvent::Exited {
                    code: Some(0),
                    signal: None,
                },
                now(),
                now_ms(),
            )
            .expect("recorded");
        assert_eq!(registry.live_count(), 1);
        registry.insert(session("s3")).expect("slot freed");

        // Replacing an existing id is not a new live session.
        registry.insert(session("s2")).expect("replace in place");
    }

    #[test]
    fn the_snapshot_reports_phase_pendings_and_the_replay_cursor() {
        let mut registry = SessionRegistry::new();
        registry.insert(session("s1")).unwrap();
        let s = registry.get_mut("s1").unwrap();
        s.on_event(started(), now(), now_ms());
        s.on_user_send(now());
        s.on_event(text("hi"), now(), now_ms());
        s.on_event(permission("req_1", "Write"), now(), now_ms());

        let rows = registry.snapshot();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.session_id, "s1");
        assert_eq!(row.phase, SessionPhase::NeedsYou);
        assert_eq!(row.pending_count, 1);
        assert_eq!(row.company.as_deref(), Some("indigo"));
        assert_eq!(row.model.as_deref(), Some("claude-haiku-4-5"));
        assert_eq!(row.last_seq, 2, "Started, TextDelta, PermissionRequest");
        assert_eq!(row.tool, SessionTool::Claude);
    }

    #[test]
    fn the_summary_is_camel_case_on_the_wire() {
        let registry = {
            let mut r = SessionRegistry::new();
            r.insert(session("s1")).unwrap();
            r
        };
        let raw = serde_json::to_value(&registry.snapshot()[0]).expect("serialize");
        for key in [
            "sessionId",
            "phase",
            "cwd",
            "startedAt",
            "lastActivityAt",
            "lastSeq",
            "pendingCount",
            "effort",
            "permissionMode",
        ] {
            assert!(raw.get(key).is_some(), "missing {key} in {raw}");
        }
        assert!(raw.get("session_id").is_none());
        assert!(raw.get("permission_mode").is_none());
        assert_eq!(raw["permissionMode"], "prompt");
    }

    #[test]
    fn the_summary_carries_the_effort_and_permission_mode_the_session_was_launched_with() {
        let mut registry = SessionRegistry::new();
        let mut high = spec("s1", PermissionMode::BypassAll);
        high.effort = Some("high".into());
        registry
            .insert(LiveSession::new(high, "2026-09-01T00:00:00Z".into()))
            .unwrap();

        let row = &registry.snapshot()[0];
        assert_eq!(row.effort.as_deref(), Some("high"));
        assert_eq!(row.permission_mode, PermissionMode::BypassAll);

        // A session launched without an effort reports none rather than a
        // fabricated default.
        let mut plain = SessionRegistry::new();
        plain.insert(session("s2")).unwrap();
        assert_eq!(plain.snapshot()[0].effort, None);
        assert_eq!(plain.snapshot()[0].permission_mode, PermissionMode::Prompt);
    }

    // ── timestamps + the operator's own turns ───────────────────────────────

    #[test]
    fn every_recorded_event_is_stamped_with_the_instant_it_was_recorded() {
        let mut s = session("s1");
        let first = s.on_event(started(), now(), ms(10)).expect("recorded");
        assert_eq!(first.received_at_ms, ms(10), "the outcome echoes the stamp");
        s.on_event(text("hi"), now(), ms(20)).expect("recorded");
        s.on_event(turn_done(), now(), ms(30)).expect("recorded");

        let stamps: Vec<u64> = s
            .buffer
            .replay(0)
            .events
            .iter()
            .map(|entry| entry.received_at_ms)
            .collect();
        assert_eq!(
            stamps,
            vec![ms(10), ms(20), ms(30)],
            "each event keeps its own arrival instant, not the replay's"
        );
    }

    #[test]
    fn a_user_message_is_buffered_ahead_of_the_reply_it_provoked() {
        // The gap this closes: the buffer used to hold only the agent's half,
        // so `agent_session_replay` returned a monologue and a reopened
        // session lost every question the operator had asked.
        let mut s = session("s1");
        s.on_event(started(), now(), ms(0));
        s.on_event(
            SessionEvent::UserMessage {
                text: "do the thing".into(),
                image_count: 1,
            },
            now(),
            ms(1),
        )
        .expect("recorded");
        s.on_user_send(now());
        s.on_event(text("on it"), now(), ms(2));

        let events: Vec<SessionEvent> = s
            .buffer
            .replay(0)
            .events
            .into_iter()
            .map(|entry| entry.event)
            .collect();
        assert!(
            matches!(
                &events[1],
                SessionEvent::UserMessage { text, image_count }
                    if text == "do the thing" && *image_count == 1
            ),
            "the operator's turn is in the transcript: {:?}",
            events[1]
        );
        assert!(
            matches!(&events[2], SessionEvent::TextDelta { text, .. } if text == "on it"),
            "and it sits BEFORE the agent's answer: {events:?}"
        );
        // A user turn is transcript content, not a phase edge — `on_user_send`
        // is what moves the session to Working.
        assert_eq!(s.phase, SessionPhase::Working);
    }

    #[test]
    fn the_truncation_marker_is_dated_by_the_span_it_stands_in_for() {
        let mut ring = EventRing::with_bounds(2, RING_MAX_BYTES);
        for i in 0..5 {
            ring.push(text(&format!("t{i}")), ms(i));
        }
        // Retained: 3, 4. Dropped: 0, 1, 2 — the marker takes seq 2's stamp.
        let replay = ring.replay(0);
        assert!(replay.truncated);
        assert_eq!(replay.events[0].received_at_ms, ms(2));
        assert_eq!(replay.events[1].received_at_ms, ms(3));
        assert_eq!(replay.events[2].received_at_ms, ms(4));
    }
}
