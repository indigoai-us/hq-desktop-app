//! HQ-DESKTOP-6C: stdout/stderr diagnostics on a broken pipe must never panic a
//! thread.
//!
//! Drives the `stdio_epipe_probe` binary with a pipe whose read end is dropped,
//! so the child's writes fail with EPIPE (`Broken pipe (os error 32)`) — the
//! exact condition Stefan's process hit. The best-effort helpers must survive
//! it; std's `eprintln!` (the mechanism guard) must reproduce the exact Sentry
//! panic title.
#![cfg(unix)]

use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

/// Which of the child's streams is a broken pipe.
#[derive(Clone, Copy)]
enum PipeStream {
    Stdout,
    Stderr,
}

struct ProbeOutcome {
    code: Option<i32>,
    /// Contents of the panic file (empty when the probe never panicked).
    panic: String,
    /// Contents of the survival marker file.
    mark: String,
}

/// Wait up to `deadline` for the child to exit, killing it if it overruns so a
/// hung probe can never wedge the test binary. Bounded by construction.
fn wait_bounded(child: &mut Child, deadline: Duration) -> ExitStatus {
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            return status;
        }
        if start.elapsed() >= deadline {
            let _ = child.kill();
            return child.wait().expect("wait after kill");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Spawn the probe in `mode` with `pipe_stream` as a pipe whose reader we drop
/// immediately, then collect its exit code plus the panic/marker files.
fn run_probe(mode: &str, pipe_stream: PipeStream) -> ProbeOutcome {
    let tmp = tempfile::tempdir().expect("tempdir");
    let panic_file = tmp.path().join("panic.txt");
    let mark_file = tmp.path().join("mark.txt");

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_stdio_epipe_probe"));
    cmd.env("HQ_STDIO_PROBE_MODE", mode)
        .env("HQ_STDIO_PROBE_PANIC_FILE", &panic_file)
        .env("HQ_STDIO_PROBE_MARK_FILE", &mark_file);

    // Pipe the stream under test; send the other to /dev/null so nothing the
    // child writes can block on the test harness's own fds.
    match pipe_stream {
        PipeStream::Stderr => {
            cmd.stderr(Stdio::piped()).stdout(Stdio::null());
        }
        PipeStream::Stdout => {
            cmd.stdout(Stdio::piped()).stderr(Stdio::null());
        }
    }

    let mut child = cmd.spawn().expect("spawn stdio_epipe_probe");

    // Drop the read end of the piped stream now, before the child wakes and
    // writes, so its write lands on a closed reader → EPIPE.
    match pipe_stream {
        PipeStream::Stderr => drop(child.stderr.take()),
        PipeStream::Stdout => drop(child.stdout.take()),
    }

    let status = wait_bounded(&mut child, Duration::from_secs(10));

    // Read the files while the tempdir is still alive.
    let panic = std::fs::read_to_string(&panic_file).unwrap_or_default();
    let mark = std::fs::read_to_string(&mark_file).unwrap_or_default();

    ProbeOutcome {
        code: status.code(),
        panic,
        mark,
    }
}

#[test]
fn best_effort_eprintln_survives_a_broken_stderr_pipe() {
    let out = run_probe("best-effort", PipeStream::Stderr);
    assert_eq!(
        out.code,
        Some(0),
        "best-effort stderr must exit 0; panic file: {:?}",
        out.panic
    );
    assert!(
        out.mark.contains("survived"),
        "the worker thread must have joined cleanly (mark: {:?})",
        out.mark
    );
    assert!(
        out.panic.trim().is_empty(),
        "the best-effort path must not panic; got: {:?}",
        out.panic
    );
}

#[test]
fn best_effort_stdout_survives_a_broken_stdout_pipe() {
    // Same guarantee for stdout — the headless-install progress stream writes
    // there and must keep running when its reader goes away.
    let out = run_probe("best-effort-stdout", PipeStream::Stdout);
    assert_eq!(
        out.code,
        Some(0),
        "best-effort stdout must exit 0; panic file: {:?}",
        out.panic
    );
    assert!(
        out.mark.contains("survived"),
        "the worker thread must have joined cleanly (mark: {:?})",
        out.mark
    );
    assert!(
        out.panic.trim().is_empty(),
        "the best-effort path must not panic; got: {:?}",
        out.panic
    );
}

#[test]
fn std_eprintln_panics_when_the_stderr_reader_is_gone() {
    // Mechanism guard (inverse case): without the best-effort helper, std's
    // macro panics with the exact HQ-DESKTOP-6C Sentry title. This is the
    // production failure the fix removes.
    let out = run_probe("std", PipeStream::Stderr);
    assert_eq!(
        out.code,
        Some(101),
        "std eprintln! must panic the worker thread; marker: {:?}",
        out.mark
    );
    assert!(
        out.panic
            .contains("failed printing to stderr: Broken pipe (os error 32)"),
        "must reproduce the exact Sentry panic title, got: {:?}",
        out.panic
    );
    assert!(
        !out.mark.contains("survived"),
        "the worker must not have survived the std-macro path"
    );
}
