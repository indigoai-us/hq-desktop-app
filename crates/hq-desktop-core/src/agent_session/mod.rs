//! The pure session model for driving an agent CLI.
//!
//! No process, no Tauri, no I/O: [`types`] holds the launch spec and the
//! normalized event stream, [`claude_wire`] turns a spec into argv and parses
//! / builds Claude `stream-json` lines, and [`claude_normalize`] folds those
//! frames into [`types::SessionEvent`]s. [`codex_wire`] and
//! [`codex_normalize`] are the same pair for Codex's `app-server` JSON-RPC
//! protocol, reduced to the SAME event stream — which is the point of the
//! split: a second agent CLI is a second wire module, not a second UI.
//! [`registry`] holds the live-session state (phase machine, bounded replay
//! ring, permission policy) those events drive. The runner that owns the child
//! process composes these.

pub mod claude_normalize;
pub mod claude_wire;
pub mod codex_normalize;
pub mod codex_wire;
pub mod policy_digest;
pub mod registry;
pub mod types;

#[cfg(test)]
pub(crate) mod fixtures;

pub use claude_normalize::ClaudeNormalizer;
pub use claude_wire::{frame_from_value, CanUseTool, Frame};
pub use codex_normalize::CodexNormalizer;
pub use policy_digest::{merge_policy_digest, parse_policy_digest, PolicyDigest, PolicyEntry};
pub use registry::{
    decide_can_use_tool, AutoDecision, EventOutcome, EventRing, LiveSession, NeedsYou,
    PendingRequest, PhaseChange, Replay, ReplayEntry, SessionRegistry, SessionSummary,
    MAX_LIVE_SESSIONS,
};
pub use types::{
    DoneStatus, PermissionDecision, PermissionMode, Question, QuestionAnswer, QuestionOption,
    SessionEvent, SessionPhase, SessionSpec, SessionTool, SlashCommand, TurnOverrides,
    HOOK_NOTICE_TEXT_CAP,
};
