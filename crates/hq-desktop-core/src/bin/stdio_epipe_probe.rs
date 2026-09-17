//! HQ-DESKTOP-6C reproduction/regression probe.
//!
//! Spawned by `tests/process_stdio_broken_pipe.rs`. The parent gives this
//! process a stdout or stderr pipe and then drops the read end, so any write to
//! that fd fails with `EPIPE` (`Broken pipe (os error 32)`). The Rust runtime
//! ignores `SIGPIPE`, so the write returns the error instead of the process
//! being signalled. A background thread then writes two diagnostic lines and the
//! main thread reports whether that thread survived.
//!
//! Modes (via `HQ_STDIO_PROBE_MODE`):
//! - `best-effort`        — write to stderr via `best_effort_eprintln!` (the fix).
//! - `best-effort-stdout` — write to stdout via `best_effort_println!` (the fix).
//! - `std`                — write to stderr via std `eprintln!` (the defect).
//!
//! stderr is (in the tested mode) the broken pipe, so the panic hook cannot
//! report to it; it appends the panic payload to `HQ_STDIO_PROBE_PANIC_FILE`.
//! On a clean join the process appends `survived` to `HQ_STDIO_PROBE_MARK_FILE`
//! and exits 0; a panicked worker thread makes it exit 101.

use std::fs::OpenOptions;
use std::io::Write;
use std::time::Duration;
use std::{env, panic, process, thread};

/// Append `line` to the file named by env var `var`, if that var is set.
/// Best-effort and File-backed, so it works even while stderr is broken.
fn append(var: &str, line: &str) {
    if let Ok(path) = env::var(var) {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn main() {
    let mode = env::var("HQ_STDIO_PROBE_MODE").unwrap_or_default();

    // Route panic reporting to a file: in the tested mode stderr is the broken
    // pipe, so the default hook's stderr print would itself fail. Replacing the
    // hook also means the default "thread panicked" stderr write never runs.
    panic::set_hook(Box::new(|info| {
        let payload = info
            .payload()
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| info.payload().downcast_ref::<&str>().copied())
            .unwrap_or("<non-string panic payload>");
        append("HQ_STDIO_PROBE_PANIC_FILE", payload);
    }));

    let worker_mode = mode.clone();
    let worker = thread::spawn(move || {
        // Let the parent close the read end before we write, so the pipe is
        // already broken on the first write. Once the reader is gone EPIPE is
        // deterministic, independent of any further timing.
        thread::sleep(Duration::from_millis(300));
        match worker_mode.as_str() {
            "best-effort" => {
                hq_desktop_core::best_effort_eprintln!("hq-desktop-6c probe line {}", 1);
                hq_desktop_core::best_effort_eprintln!("hq-desktop-6c probe line 2");
            }
            "best-effort-stdout" => {
                hq_desktop_core::best_effort_println!("hq-desktop-6c probe line {}", 1);
                hq_desktop_core::best_effort_println!("hq-desktop-6c probe line 2");
            }
            "std" => {
                // The defect: std's macro turns the EPIPE write into a panic.
                eprintln!("hq-desktop-6c probe line {}", 1);
                eprintln!("hq-desktop-6c probe line 2");
            }
            other => {
                append(
                    "HQ_STDIO_PROBE_PANIC_FILE",
                    &format!("unknown HQ_STDIO_PROBE_MODE: {other}"),
                );
            }
        }
    });

    match worker.join() {
        Ok(()) => {
            append("HQ_STDIO_PROBE_MARK_FILE", "survived");
            process::exit(0);
        }
        Err(_) => {
            // The worker panicked (std mode over a broken pipe). Mirror Rust's
            // own panic exit code so the test can assert on it.
            process::exit(101);
        }
    }
}
