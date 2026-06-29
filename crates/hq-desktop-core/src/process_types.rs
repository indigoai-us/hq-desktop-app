use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Arguments for `spawn_process`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnArgs {
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Option<HashMap<String, String>>,
}

/// Payload for `process://{handle}/stdout` events.
#[derive(Debug, Serialize, Clone)]
pub struct StdoutEvent {
    pub line: String,
}

/// Payload for `process://{handle}/stderr` events.
#[derive(Debug, Serialize, Clone)]
pub struct StderrEvent {
    pub line: String,
}

/// Payload for the terminal `process://{handle}/exit` event.
///
/// `signal` is `Some(N)` only when the OS killed the process with a Unix
/// signal — in that case `code` is `None`. Distinguishes "runner crashed
/// with SIGSEGV" (signal=11) from "runner OOM-killed" (signal=9) from
/// "runner cancelled" (signal=15) from a normal `exit(code)`.
#[derive(Debug, Serialize, Clone)]
pub struct ExitEvent {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub success: bool,
}

pub enum ProcessEvent {
    Stdout(String),
    Stderr(String),
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
        success: bool,
    },
}
