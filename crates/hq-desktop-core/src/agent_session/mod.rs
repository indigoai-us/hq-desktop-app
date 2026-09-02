//! The pure session model for driving an agent CLI.
//!
//! No process, no Tauri, no I/O: [`types`] holds the launch spec and the
//! normalized event stream, [`claude_wire`] turns a spec into argv and parses
//! / builds Claude `stream-json` lines, and [`claude_normalize`] folds those
//! frames into [`types::SessionEvent`]s. The runner that owns the child
//! process composes these three.

pub mod claude_normalize;
pub mod claude_wire;
pub mod types;

#[cfg(test)]
pub(crate) mod fixtures;

pub use claude_normalize::ClaudeNormalizer;
pub use claude_wire::{CanUseTool, Frame};
pub use types::{
    DoneStatus, PermissionDecision, PermissionMode, Question, QuestionAnswer, QuestionOption,
    SessionEvent, SessionPhase, SessionSpec, SessionTool, SlashCommand,
};
