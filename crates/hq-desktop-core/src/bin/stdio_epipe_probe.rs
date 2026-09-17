//! Test-only probe binary for the HQ-DESKTOP-6C broken-pipe contract.
//!
//! Driven by `tests/process_stdio_broken_pipe.rs`, which spawns this binary
//! with its stdout or stderr set to a pipe whose read end it then drops, so the
//! next write to that fd fails with `EPIPE` (`Broken pipe (os error 32)`). The
//! probe writes diagnostics from a spawned (non-main) thread, mirroring the
//! tokio worker threads in the real app.
//!
//! Modes (via `HQ_STDIO_PROBE_MODE`):
//!   - `best-effort`        — write via `best_effort_eprintln!` (must survive)
//!   - `best-effort-stdout` — write via `best_effort_println!`  (must survive)
//!   - `std`                — write via std `eprintln!`         (must panic)
//!
//! In the stderr modes, stderr is the broken pipe under test, so the panic hook
//! cannot use it: it appends the panic payload to `HQ_STDIO_PROBE_PANIC_FILE`.
//! On a clean join the probe appends `survived` to `HQ_STDIO_PROBE_MARK_FILE`
//! and exits 0; a thread panic makes the join fail and the probe exits 101.

use std::fs::OpenOptions;
use std::io::Write as _;
use std::thread;
use std::time::Duration;

/// Append `text` to the file named by env var `path_var`, best-effort. Used for
/// the panic payload and the survival marker — never for stderr, which is the
/// pipe under test.
fn append(path_var: &str, text: &str) {
    if let Ok(path) = std::env::var(path_var) {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(text.as_bytes());
            let _ = file.flush();
        }
    }
}

fn main() {
    let mode = std::env::var("HQ_STDIO_PROBE_MODE").unwrap_or_default();

    // stderr is (in the stderr modes) the broken pipe under test, so the panic
    // hook records the payload to a file instead of the default stderr writer.
    std::panic::set_hook(Box::new(|info| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        append("HQ_STDIO_PROBE_PANIC_FILE", &format!("{payload}\n"));
    }));

    let worker = thread::spawn(move || {
        // Let the parent close the read end of the pipe first; once it is
        // closed EPIPE is deterministic regardless of any further timing.
        thread::sleep(Duration::from_millis(300));
        match mode.as_str() {
            "best-effort" => {
                hq_desktop_core::best_effort_eprintln!("probe stderr line {}", 1);
                hq_desktop_core::best_effort_eprintln!("probe stderr line {}", 2);
            }
            "best-effort-stdout" => {
                hq_desktop_core::best_effort_println!("probe stdout line {}", 1);
                hq_desktop_core::best_effort_println!("probe stdout line {}", 2);
            }
            "std" => {
                // The production defect: std's macro panics on EPIPE. The first
                // line panics, so the second never runs.
                eprintln!("probe stderr line {}", 1);
                eprintln!("probe stderr line {}", 2);
            }
            other => {
                append(
                    "HQ_STDIO_PROBE_PANIC_FILE",
                    &format!("unknown HQ_STDIO_PROBE_MODE: {other}\n"),
                );
            }
        }
    });

    // The worker thread panics (std mode) or returns (best-effort modes). The
    // main thread survives either way — matching production, where a panicking
    // worker task does not take the process down. Report which happened via the
    // exit code the test asserts on.
    if worker.join().is_ok() {
        append("HQ_STDIO_PROBE_MARK_FILE", "survived\n");
        std::process::exit(0);
    }
    std::process::exit(101);
}
