//! Impure process scan boundary for the shared sessions liveness engine.

use hq_desktop_core::sessions::liveness::{classify_processes, RunningAgents};

/// Scan the running process table (best-effort) for live `claude` / `codex`
/// processes via `pgrep -fl`, then delegate parsing to the core pure liveness
/// engine.
pub fn scan_running_agents() -> RunningAgents {
    // `pgrep -fl` prints "<pid> <full command line>" per match. The pattern is an
    // ERE alternation so a single spawn covers both tools. A non-zero exit (e.g.
    // "no processes matched") is fine — we just get empty output.
    let output = std::process::Command::new("pgrep")
        .arg("-fl")
        .arg("claude|codex")
        .output();

    let stdout = match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
        // pgrep absent / not executable → assume nothing live (best-effort).
        Err(_) => String::new(),
    };

    classify_processes(&stdout)
}
