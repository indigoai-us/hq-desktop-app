//! Best-effort stdout/stderr diagnostics that never panic on a broken pipe.
//!
//! # Why this exists (HQ-DESKTOP-6C)
//!
//! Rust's std print macros (`eprintln!`/`eprint!`/`println!`/`print!`) call
//! `std::io::stdio::print_to`, which **panics** for every write error except
//! `EBADF`:
//!
//! ```text
//! panic!("failed printing to {label}: {e}")
//! ```
//!
//! The Rust runtime sets `SIGPIPE` to `SIG_IGN` at startup, so a write to a
//! pipe whose read end has closed returns `EPIPE` (`Broken pipe (os error 32)`)
//! instead of killing the process — and std then turns that `EPIPE` into a
//! panic. In the macOS menubar app (`hq-sync-menubar`) fd 1/2 are normally
//! `/dev/null`, but when the app is launched from a terminal pipeline or a tool
//! runner that captured its output and then went away, the next diagnostic
//! `eprintln!` on any (tokio worker) thread panics with
//! `failed printing to stderr: Broken pipe (os error 32)`. `[profile.release]`
//! does not set `panic = "abort"`, so each panic unwinds only the thread that
//! was running — the task it was driving dies (a `JoinError`), the process
//! survives, and the frontend `invoke` awaiting that task never resolves. That
//! is the incident behind HQ-DESKTOP-6C.
//!
//! # The contract
//!
//! A GUI app's stdout/stderr are best-effort diagnostic channels; they must
//! never be able to panic a thread. These helpers take the stream lock once,
//! write the formatted text (with the newline under the same lock so a line
//! stays atomic), and treat any I/O error as best-effort — no panic, no
//! `unwrap`. The **first** failure per stream is recorded once to the durable
//! log ([`crate::logfile::log`], `~/.hq/logs/hq-sync.log`, `[stdio]` tag) so the
//! failure is observable rather than silently swallowed; later failures on the
//! same stream are dropped without re-logging so a hot loop cannot spam the log.
//! `~/.hq/logs/hq-sync.log` remains the only durable diagnostic channel.
//!
//! # How every call site is covered
//!
//! The two crate roots — `crates/hq-desktop-core/src/lib.rs` and
//! `apps/sync/src-tauri/src/main.rs` — shadow the std prelude print macros with
//! the `best_effort_*` macros below, so every existing `eprintln!`/`eprint!`/
//! `println!`/`print!` call site routes here with no call-site change. See the
//! shadow definitions there and `scripts/process-stdio-contract.test.ts`, which
//! pins that they exist, delegate here, are `cfg(not(test))`, and stay above the
//! first `mod` declaration (textual macro scope only reaches modules declared
//! after the definition).

use std::fmt;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};

/// Latched after the first stderr write failure so the durable log records it
/// exactly once per process (see [`record_first_failure`]).
static STDERR_FAILED: AtomicBool = AtomicBool::new(false);
/// Latched after the first stdout write failure.
static STDOUT_FAILED: AtomicBool = AtomicBool::new(false);

/// `eprintln!`-equivalent: write `args` plus a trailing newline to stderr,
/// best-effort. Never panics.
pub fn stderr_line(args: fmt::Arguments<'_>) {
    let mut stream = io::stderr().lock();
    write_best_effort(&mut stream, args, true, &STDERR_FAILED, Stream::Stderr);
}

/// `eprint!`-equivalent: write `args` to stderr with no trailing newline,
/// best-effort. Never panics.
pub fn stderr_fragment(args: fmt::Arguments<'_>) {
    let mut stream = io::stderr().lock();
    write_best_effort(&mut stream, args, false, &STDERR_FAILED, Stream::Stderr);
}

/// `println!`-equivalent: write `args` plus a trailing newline to stdout,
/// best-effort. Never panics.
pub fn stdout_line(args: fmt::Arguments<'_>) {
    let mut stream = io::stdout().lock();
    write_best_effort(&mut stream, args, true, &STDOUT_FAILED, Stream::Stdout);
}

/// `print!`-equivalent: write `args` to stdout with no trailing newline,
/// best-effort. Never panics.
pub fn stdout_fragment(args: fmt::Arguments<'_>) {
    let mut stream = io::stdout().lock();
    write_best_effort(&mut stream, args, false, &STDOUT_FAILED, Stream::Stdout);
}

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

impl Stream {
    fn label(self) -> &'static str {
        match self {
            Stream::Stdout => "stdout",
            Stream::Stderr => "stderr",
        }
    }
}

/// Write `args` (and, when `newline`, a trailing `\n`) to an already-locked
/// stream, swallowing any I/O error. On the first error observed through
/// `latch`, record one line to the durable log; never panics.
///
/// Generic over the writer so tests can drive it with a writer that always
/// fails, exercising the best-effort path without a real broken pipe.
fn write_best_effort<W: Write>(
    stream: &mut W,
    args: fmt::Arguments<'_>,
    newline: bool,
    latch: &AtomicBool,
    which: Stream,
) {
    let result = (|| -> io::Result<()> {
        stream.write_fmt(args)?;
        if newline {
            stream.write_all(b"\n")?;
        }
        Ok(())
    })();
    if let Err(err) = result {
        record_first_failure(latch, which, &err);
    }
}

/// Record the first write failure for a stream to the durable log, exactly
/// once per process. Best-effort like everything else here.
fn record_first_failure(latch: &AtomicBool, which: Stream, err: &io::Error) {
    // `swap` returns the previous value: only the first caller sees `false`, so
    // a hot loop of failing writes records a single line, not one per write.
    if !latch.swap(true, Ordering::Relaxed) {
        let label = which.label();
        crate::logfile::log(
            "stdio",
            &format!("{label} write failed: {err}; further {label} diagnostics are dropped"),
        );
    }
}

/// Best-effort replacement for `eprintln!`. Routes through
/// [`crate::process_stdio::stderr_line`] so a broken stderr pipe cannot panic
/// the thread. `#[macro_export]`ed so both crate roots can delegate to it.
#[macro_export]
macro_rules! best_effort_eprintln {
    ($($arg:tt)*) => {
        $crate::process_stdio::stderr_line(::core::format_args!($($arg)*))
    };
}

/// Best-effort replacement for `eprint!` (no trailing newline).
#[macro_export]
macro_rules! best_effort_eprint {
    ($($arg:tt)*) => {
        $crate::process_stdio::stderr_fragment(::core::format_args!($($arg)*))
    };
}

/// Best-effort replacement for `println!`.
#[macro_export]
macro_rules! best_effort_println {
    ($($arg:tt)*) => {
        $crate::process_stdio::stdout_line(::core::format_args!($($arg)*))
    };
}

/// Best-effort replacement for `print!` (no trailing newline).
#[macro_export]
macro_rules! best_effort_print {
    ($($arg:tt)*) => {
        $crate::process_stdio::stdout_fragment(::core::format_args!($($arg)*))
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logfile::LogOverrideGuard;

    /// A writer whose every write fails with a broken pipe, exercising the
    /// best-effort path deterministically without a real pipe.
    struct BrokenWriter;
    impl Write for BrokenWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "Broken pipe (os error 32)",
            ))
        }
        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "Broken pipe (os error 32)",
            ))
        }
    }

    /// A writer that records everything written to it.
    #[derive(Default)]
    struct CapturingWriter {
        bytes: Vec<u8>,
    }
    impl Write for CapturingWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.bytes.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn first_write_failure_is_logged_once_then_silenced() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let log_path = tmp.path().join("hq-sync.log");
        let _guard = LogOverrideGuard::new(log_path.clone());

        // A fresh, test-local latch (never touches the process-global ones).
        let latch = AtomicBool::new(false);
        let mut writer = BrokenWriter;
        // Three failing writes; only the first is allowed to reach the log.
        write_best_effort(
            &mut writer,
            format_args!("first {}", 1),
            true,
            &latch,
            Stream::Stderr,
        );
        write_best_effort(
            &mut writer,
            format_args!("second {}", 2),
            true,
            &latch,
            Stream::Stderr,
        );
        write_best_effort(
            &mut writer,
            format_args!("third"),
            false,
            &latch,
            Stream::Stderr,
        );

        let contents = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert_eq!(
            contents.matches("[stdio]").count(),
            1,
            "a hot loop of failures must record exactly one line, got: {contents:?}"
        );
        assert!(
            contents.contains("stderr write failed"),
            "the one line must name the failing stream: {contents:?}"
        );
    }

    #[test]
    fn successful_writes_record_nothing_and_line_appends_one_newline() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let log_path = tmp.path().join("hq-sync.log");
        let _guard = LogOverrideGuard::new(log_path.clone());

        let latch = AtomicBool::new(false);

        let mut line_writer = CapturingWriter::default();
        write_best_effort(
            &mut line_writer,
            format_args!("hello {}", "world"),
            true,
            &latch,
            Stream::Stdout,
        );
        assert_eq!(
            line_writer.bytes, b"hello world\n",
            "the *_line variant must append exactly one newline under the lock"
        );

        let mut fragment_writer = CapturingWriter::default();
        write_best_effort(
            &mut fragment_writer,
            format_args!("frag"),
            false,
            &latch,
            Stream::Stdout,
        );
        assert_eq!(
            fragment_writer.bytes, b"frag",
            "the fragment variant must not append a newline"
        );

        let contents = std::fs::read_to_string(&log_path).unwrap_or_default();
        assert!(
            !contents.contains("[stdio]"),
            "a successful write must not touch the durable log: {contents:?}"
        );
    }
}
