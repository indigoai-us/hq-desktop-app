//! Best-effort stdout/stderr diagnostics that never panic (HQ-DESKTOP-6C).
//!
//! Rust's std print macros (`print!`/`println!`/`eprint!`/`eprintln!`) call
//! `std::io::stdio::print_to`, which does `panic!("failed printing to {label}: {e}")`
//! for every write error except `EBADF`. The Rust runtime sets `SIGPIPE` to
//! `SIG_IGN` at startup, so a write to a pipe whose read end has closed returns
//! `EPIPE` (`Broken pipe (os error 32)`) instead of the process being signalled
//! — and std turns that `EPIPE` into a panic. In `hq-sync-menubar` those macros
//! run on tokio worker threads; because `[profile.release]` does not set
//! `panic = "abort"`, each panic unwinds only its own thread, silently killing
//! whatever task was running (the frontend `invoke` awaiting it never resolves).
//! HQ-DESKTOP-6C is exactly that: two worker threads in one process panicked
//! with `failed printing to stderr: Broken pipe (os error 32)`, nine minutes
//! apart, because an external launcher had put a now-readerless pipe on fd 2.
//!
//! A GUI app's stdout/stderr are best-effort diagnostics. The helpers here take
//! the same lock the std macros take and write the same bytes, but treat any
//! write error as "the diagnostic was dropped" rather than a panic. The durable
//! diagnostic channel remains `~/.hq/logs/hq-sync.log` ([`crate::logfile::log`]);
//! the first dropped write per stream is recorded there once, so the failure is
//! visible without spamming the log from a hot loop.
//!
//! The two crate roots (`crates/hq-desktop-core/src/lib.rs` and
//! `apps/sync/src-tauri/src/main.rs`) shadow the std print macros with the
//! `best_effort_*` macros at the bottom of this file, so every existing call
//! site routes here with no call-site churn. `scripts/process-stdio-contract.test.ts`
//! pins that wiring.

use std::fmt;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};

/// Which standard stream a best-effort write targets.
#[derive(Clone, Copy)]
enum Stream {
    Stderr,
    Stdout,
}

impl Stream {
    fn label(self) -> &'static str {
        match self {
            Stream::Stderr => "stderr",
            Stream::Stdout => "stdout",
        }
    }
}

/// Latched the first time a write to the matching stream fails, so the durable
/// log records the failure exactly once instead of on every dropped line.
static STDERR_FAILED: AtomicBool = AtomicBool::new(false);
static STDOUT_FAILED: AtomicBool = AtomicBool::new(false);

fn failure_latch(stream: Stream) -> &'static AtomicBool {
    match stream {
        Stream::Stderr => &STDERR_FAILED,
        Stream::Stdout => &STDOUT_FAILED,
    }
}

/// Record the first write failure for `stream` in the durable log, once.
///
/// Best-effort like everything else here: [`crate::logfile::log`] never panics.
/// Subsequent failures on the same stream are swallowed silently so a broken
/// pipe in a hot loop cannot flood the log.
fn note_write_failure(stream: Stream, err: &io::Error) {
    if failure_latch(stream)
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        crate::logfile::log(
            "stdio",
            &format!(
                "{} write failed: {err}; further {} diagnostics are dropped",
                stream.label(),
                stream.label()
            ),
        );
    }
}

/// Write `args` then a single newline to `out`, so a line stays atomic under the
/// one borrow the caller already holds (the stream lock).
fn write_line_to(mut out: impl Write, args: fmt::Arguments<'_>) -> io::Result<()> {
    out.write_fmt(args)?;
    out.write_all(b"\n")
}

/// `eprintln!`-shaped: format `args`, append a newline, write to stderr. Never panics.
pub fn stderr_line(args: fmt::Arguments<'_>) {
    if let Err(e) = write_line_to(io::stderr().lock(), args) {
        note_write_failure(Stream::Stderr, &e);
    }
}

/// `eprint!`-shaped: format `args`, write to stderr, no trailing newline. Never panics.
pub fn stderr_fragment(args: fmt::Arguments<'_>) {
    if let Err(e) = io::stderr().lock().write_fmt(args) {
        note_write_failure(Stream::Stderr, &e);
    }
}

/// `println!`-shaped: format `args`, append a newline, write to stdout. Never panics.
pub fn stdout_line(args: fmt::Arguments<'_>) {
    if let Err(e) = write_line_to(io::stdout().lock(), args) {
        note_write_failure(Stream::Stdout, &e);
    }
}

/// `print!`-shaped: format `args`, write to stdout, no trailing newline. Never panics.
pub fn stdout_fragment(args: fmt::Arguments<'_>) {
    if let Err(e) = io::stdout().lock().write_fmt(args) {
        note_write_failure(Stream::Stdout, &e);
    }
}

/// Best-effort `eprintln!`: like `eprintln!` but never panics when stderr is a
/// closed or broken pipe (HQ-DESKTOP-6C).
#[macro_export]
macro_rules! best_effort_eprintln {
    () => { $crate::process_stdio::stderr_line(::core::format_args!("")) };
    ($($arg:tt)*) => { $crate::process_stdio::stderr_line(::core::format_args!($($arg)*)) };
}

/// Best-effort `eprint!`: like `eprint!` but never panics when stderr is a closed
/// or broken pipe (HQ-DESKTOP-6C).
#[macro_export]
macro_rules! best_effort_eprint {
    ($($arg:tt)*) => { $crate::process_stdio::stderr_fragment(::core::format_args!($($arg)*)) };
}

/// Best-effort `println!`: like `println!` but never panics when stdout is a
/// closed or broken pipe (HQ-DESKTOP-6C).
#[macro_export]
macro_rules! best_effort_println {
    () => { $crate::process_stdio::stdout_line(::core::format_args!("")) };
    ($($arg:tt)*) => { $crate::process_stdio::stdout_line(::core::format_args!($($arg)*)) };
}

/// Best-effort `print!`: like `print!` but never panics when stdout is a closed
/// or broken pipe (HQ-DESKTOP-6C).
#[macro_export]
macro_rules! best_effort_print {
    ($($arg:tt)*) => { $crate::process_stdio::stdout_fragment(::core::format_args!($($arg)*)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reset both stream latches so each test starts unlatched. Safe because
    /// every test that touches the latches also holds the `logfile`
    /// `LogOverrideGuard`, which serialises on a process-global lock.
    fn reset_latches() {
        STDERR_FAILED.store(false, Ordering::SeqCst);
        STDOUT_FAILED.store(false, Ordering::SeqCst);
    }

    /// A writer that always fails, to drive the failure path deterministically
    /// without a real broken pipe.
    struct FailingWriter;
    impl Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "broken pipe (test)",
            ))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn write_line_appends_exactly_one_newline() {
        let mut buf: Vec<u8> = Vec::new();
        write_line_to(&mut buf, format_args!("hello {}", 42)).unwrap();
        assert_eq!(buf, b"hello 42\n");
    }

    #[test]
    fn write_line_surfaces_the_underlying_error() {
        let err = write_line_to(FailingWriter, format_args!("x")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
    }

    #[test]
    fn a_failing_stream_is_logged_exactly_once_across_repeated_failures() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("hq-sync.log");
        let _guard = crate::logfile::LogOverrideGuard::new(path.clone());
        reset_latches();

        let err = io::Error::new(io::ErrorKind::BrokenPipe, "Broken pipe (os error 32)");
        note_write_failure(Stream::Stderr, &err);
        note_write_failure(Stream::Stderr, &err);
        note_write_failure(Stream::Stderr, &err);

        let contents = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            contents.matches("[stdio]").count(),
            1,
            "a broken stream must be recorded once, not per dropped line"
        );
        assert!(contents.contains("stderr write failed"));
    }

    #[test]
    fn each_stream_latches_independently() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("hq-sync.log");
        let _guard = crate::logfile::LogOverrideGuard::new(path.clone());
        reset_latches();

        let err = io::Error::new(io::ErrorKind::BrokenPipe, "Broken pipe (os error 32)");
        note_write_failure(Stream::Stderr, &err);
        note_write_failure(Stream::Stdout, &err);

        let contents = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(contents.matches("[stdio]").count(), 2);
        assert!(contents.contains("stderr write failed"));
        assert!(contents.contains("stdout write failed"));
    }
}
