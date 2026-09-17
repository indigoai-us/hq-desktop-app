//! HQ-DESKTOP-6C: a broken stdout/stderr pipe must never panic a thread.
//!
//! Drives `bin/stdio_epipe_probe` with a piped-then-dropped fd so writes hit
//! `EPIPE`. The best-effort helpers (the fix) survive; std's own `eprintln!`
//! (the defect) panics with the exact Sentry title. Unix-only: the broken-pipe
//! mechanism and the `os error 32` text are POSIX (on Windows std's stdio
//! reports `EBADF` as success, so there is nothing to guard there).

#![cfg(unix)]

use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Which stream the probe writes to — and therefore which one the parent turns
/// into a broken pipe by dropping its reader.
#[derive(Clone, Copy)]
enum Broken {
    Stderr,
    Stdout,
}

struct ProbeOutcome {
    exit_code: Option<i32>,
    panic_payload: String,
    mark: String,
}

/// Run the probe in `mode`, break `broken`'s pipe by dropping its reader, and
/// return the outcome. Kills the child after 10s so a hang cannot wedge CI.
fn run_probe(mode: &str, broken: Broken) -> ProbeOutcome {
    let tmp = tempfile::tempdir().expect("tempdir");
    let panic_file = tmp.path().join("panic.txt");
    let mark_file = tmp.path().join("mark.txt");

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_stdio_epipe_probe"));
    cmd.env("HQ_STDIO_PROBE_MODE", mode)
        .env("HQ_STDIO_PROBE_PANIC_FILE", &panic_file)
        .env("HQ_STDIO_PROBE_MARK_FILE", &mark_file)
        // Keep the probe's best-effort log write off the real ~/.hq log by
        // pointing hq_config_dir() at the throwaway tempdir.
        .env("HOME", tmp.path());

    // The stream under test is a pipe whose reader we drop; the other stream is
    // silenced so nothing blocks on a full pipe buffer.
    match broken {
        Broken::Stderr => {
            cmd.stderr(Stdio::piped()).stdout(Stdio::null());
        }
        Broken::Stdout => {
            cmd.stdout(Stdio::piped()).stderr(Stdio::null());
        }
    }

    let mut child = cmd.spawn().expect("spawn probe");

    // Drop the read end NOW, before the probe's worker thread wakes and writes,
    // so its first write already hits a readerless pipe.
    match broken {
        Broken::Stderr => drop(child.stderr.take()),
        Broken::Stdout => drop(child.stdout.take()),
    }

    // Bounded wait: a wedged child can never hang the suite.
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("probe did not exit within 10s (mode={mode})");
        }
        thread::sleep(Duration::from_millis(25));
    };

    ProbeOutcome {
        exit_code: status.code(),
        panic_payload: read_lossy(&panic_file),
        mark: read_lossy(&mark_file),
    }
}

fn read_lossy(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

#[test]
fn best_effort_eprintln_survives_a_broken_stderr_pipe() {
    let out = run_probe("best-effort", Broken::Stderr);
    assert_eq!(
        out.exit_code,
        Some(0),
        "best-effort stderr must not panic the worker thread"
    );
    assert!(
        out.mark.contains("survived"),
        "the worker thread must be joinable"
    );
    assert!(
        out.panic_payload.is_empty(),
        "no panic expected, got: {}",
        out.panic_payload
    );
}

#[test]
fn best_effort_stdout_survives_a_broken_stdout_pipe() {
    let out = run_probe("best-effort-stdout", Broken::Stdout);
    assert_eq!(
        out.exit_code,
        Some(0),
        "best-effort stdout must not panic the worker thread"
    );
    assert!(
        out.mark.contains("survived"),
        "the worker thread must be joinable"
    );
    assert!(
        out.panic_payload.is_empty(),
        "no panic expected, got: {}",
        out.panic_payload
    );
}

#[test]
fn std_eprintln_panics_when_the_stderr_reader_is_gone() {
    // Mechanism guard: the defect this fix removes. std's `eprintln!` turns the
    // EPIPE write into a panic, which unwinds the worker thread.
    let out = run_probe("std", Broken::Stderr);
    assert_eq!(
        out.exit_code,
        Some(101),
        "std eprintln! must panic the worker thread"
    );
    assert!(
        out.mark.is_empty(),
        "a panicked worker must not report survival"
    );
    assert!(
        out.panic_payload
            .contains("failed printing to stderr: Broken pipe (os error 32)"),
        "expected the exact HQ-DESKTOP-6C Sentry title, got: {:?}",
        out.panic_payload
    );
}
