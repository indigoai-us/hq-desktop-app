// ─────────────────────────────────────────────────────────────────────────────
// ATTRIBUTION
//
// Local file: crates/hq-desktop-core/src/stdio/child.rs
//
// This file is derived from `block/buzz`, file `crates/buzz-acp/src/acp.rs`,
// at commit `c5c4f39`.
//
//   Upstream: https://github.com/block/buzz
//   License:  Apache License, Version 2.0
//
// Changes from upstream: stripped all Nostr / goose coupling (steer arm, usage
// tracker, observer context, CODEX_CONFIG deep-merge, model-switch helpers,
// persona plumbing); stripped the ACP protocol layer entirely (initialize,
// session/new, session/prompt, session/cancel, permission handling, the ACP
// event enum) so what remains is a protocol-agnostic NDJSON child that a
// Claude `stream-json` driver and a Codex JSON-RPC driver can both sit on top
// of; added the `StdioProcessRegistrar` seam so children join the host app's
// exit drain; drain the child's stderr into the HQ diagnostic log instead of
// inheriting it (a GUI app has no terminal, and an undrained stderr pipe
// deadlocks the child); swapped `tracing` for `crate::logfile`; swapped `nix`
// for `libc` in the process-group kill (the crate already depends on `libc`).
//
// See the repo-root NOTICE for the full attribution.
// ─────────────────────────────────────────────────────────────────────────────

//! A bounded NDJSON child process over stdio.
//!
//! [`StdioChild`] owns one subprocess, writes newline-delimited JSON to its
//! stdin, and reads newline-delimited JSON from its stdout. It knows nothing
//! about what those frames *mean* — that is a driver's job. Two drivers are
//! planned on top of it: Claude's `stream-json` (frames are events) and
//! Codex's JSON-RPC (frames are requests/responses/notifications, which is why
//! [`StdioChild::send_request`]'s id pairing lives here).
//!
//! # Lifecycle
//! 1. [`StdioChild::spawn`] — launch the binary as a subprocess
//! 2. [`StdioChild::write_ndjson`] / [`StdioChild::send_request`] — bounded writes
//! 3. [`StdioChild::next_frame`] — bounded, idle-aware reads
//! 4. [`StdioChild::shutdown`] — process-group kill + bounded reap
//!
//! Every call is bounded. There is no unbounded read, no unbounded write, and
//! no unbounded wait anywhere in this file — talking to a pre-1.0 vendor CLI is
//! exactly the situation where "it just hangs" is the default failure mode.

use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::codec::{FramedRead, LinesCodec, LinesCodecError};

use crate::logfile;
use crate::paths;
use crate::stdio::registrar::registrar;

/// Maximum allowed size of a single NDJSON line from the child's stdout.
///
/// Lines exceeding this limit are rejected to prevent OOM from a rogue or
/// wedged child: `LinesCodec::new_with_max_length` enforces it at the *read*
/// level, so the decode buffer never grows past the cap even if the child
/// writes bytes forever without a newline.
pub const MAX_LINE_SIZE: usize = 10_000_000; // 10 MB

/// Timeout for a single stdin write. A blocked write means the child has
/// stopped reading its stdin — usually a wedged event loop.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// Default timeout for a request/response round trip.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Bounded wait for the child to actually die after a kill signal.
pub const REAP_TIMEOUT: Duration = Duration::from_secs(5);

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/// Errors that can occur talking to a stdio child.
#[derive(Debug, thiserror::Error)]
pub enum StdioError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Child process exited unexpectedly")]
    AgentExited,

    #[error("Idle timeout — no child activity for {0:?}")]
    IdleTimeout(Duration),

    #[error("Hard timeout exceeded (silence {silence:?})")]
    HardTimeout { silence: Duration },

    #[error("Request timeout — child did not respond within {0:?}")]
    Timeout(Duration),

    #[error("Write timeout — child stopped reading stdin (blocked for {0:?})")]
    WriteTimeout(Duration),

    #[error("Protocol error: {0}")]
    Protocol(String),
}

impl StdioError {
    /// True when this error means "the child process is gone, its pipes are
    /// broken, or it has stopped reading them" — i.e. the slot must be
    /// respawned rather than retried in place. Used by a supervisor to
    /// classify crash-class failures for [`crate::stdio::SlotCircuit`].
    ///
    /// [`StdioError::WriteTimeout`] counts. Its own message says "child stopped
    /// reading stdin": the process may still be listed by `ps`, but a child
    /// whose event loop no longer drains its own stdin cannot serve another
    /// turn. Leaving it `Ready` would route every subsequent turn at a corpse,
    /// burn the full [`WRITE_TIMEOUT`] on each, and never show the breaker a
    /// crash.
    pub fn is_crash_class(&self) -> bool {
        matches!(
            self,
            StdioError::AgentExited | StdioError::Io(_) | StdioError::WriteTimeout(_)
        )
    }
}

/// The error raised when the child's stdout produces a line past
/// [`MAX_LINE_SIZE`]. Built from the constant so the message can never drift
/// away from the cap the codec actually enforces.
fn max_line_exceeded_error() -> StdioError {
    StdioError::Protocol(format!(
        "child stdout line exceeded the {MAX_LINE_SIZE} byte limit"
    ))
}

// ─────────────────────────────────────────────────────────────────────────────
// Launch spec
// ─────────────────────────────────────────────────────────────────────────────

/// Everything needed to spawn one child process.
#[derive(Debug, Clone)]
pub struct StdioLaunch {
    /// Absolute path or bare name of the binary.
    pub program: String,
    /// Arguments passed to the child.
    pub args: Vec<String>,
    /// Extra environment, applied with operator-wins precedence.
    pub env: Vec<(String, String)>,
    /// Inherited variables to unset in the child, applied *before* [`Self::env`].
    ///
    /// [`Self::env`] is operator-wins and therefore cannot clear anything: a
    /// variable already present in the parent environment wins, and there is no
    /// value that means "absent". This list is the escape hatch — each name is
    /// `env_remove`d off the command, so the child starts without it even
    /// though the parent has it. Listing a name here and also in [`Self::env`]
    /// is well defined: the removal happens first, so the `env` value is what
    /// the child sees.
    pub env_remove: Vec<String>,
    /// Working directory for the child.
    pub cwd: PathBuf,
}

// ─────────────────────────────────────────────────────────────────────────────
// Child
// ─────────────────────────────────────────────────────────────────────────────

/// Owns one child subprocess and speaks NDJSON over its stdio.
pub struct StdioChild {
    /// Registry handle for this child — the key the host app's process
    /// registry (and therefore `terminate_all_for_exit`) knows it by.
    handle: String,
    /// The child process (kept alive to prevent a zombie).
    child: Child,
    /// The registrar that accepted this child; ownership must not switch mid-spawn.
    process_registrar: Option<std::sync::Arc<dyn crate::stdio::StdioProcessRegistrar>>,
    /// Write end of the child's stdin pipe. `None` once [`StdioChild::close_stdin`]
    /// has signalled end-of-input — a `stream-json` CLI treats EOF on stdin as
    /// "no more turns are coming" and exits cleanly, flushing its transcript,
    /// which a kill would not.
    stdin: Option<ChildStdin>,
    /// Framed reader over the child's stdout pipe (line-oriented, bounded by
    /// [`MAX_LINE_SIZE`]).
    reader: FramedRead<ChildStdout, LinesCodec>,
    /// Monotonically increasing JSON-RPC request id counter, for the drivers
    /// that pair requests with responses. Client-generated ids are numeric.
    next_id: u64,
    /// OS pid of the child, captured at spawn (the child leads its own process
    /// group, so pid == pgid on Unix).
    pid: Option<u32>,
    /// Optional streaming observer: every inbound frame, verbatim.
    event_sink: Option<UnboundedSender<serde_json::Value>>,
    /// Windows Job Object owning the child (and everything it spawns), stored
    /// as a raw `isize` so the field needs no `windows` types in its signature.
    /// `None` when the job could not be created — the child still works, it
    /// just degrades to a direct child kill. See [`job_object`].
    #[cfg(target_os = "windows")]
    job_handle: Option<isize>,
    /// True when *this* value must `CloseHandle` its job handle, i.e. no
    /// registrar took ownership of it at spawn time. When a registrar did take
    /// it, the host registry closes it in its own `deregister`, and a second
    /// close here would be a double-close on a recycled handle value.
    #[cfg(target_os = "windows")]
    owns_job_handle: bool,
}

impl StdioChild {
    // ── spawn / identity ────────────────────────────────────────────────────

    /// Spawn the binary as a subprocess and connect to its stdio pipes.
    pub async fn spawn(launch: &StdioLaunch) -> Result<Self, StdioError> {
        use std::process::Stdio;

        let handle = uuid::Uuid::new_v4().to_string();
        let process_registrar = registrar();

        let mut cmd = tokio::process::Command::new(&launch.program);
        cmd.args(&launch.args)
            .current_dir(&launch.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // DEVIATION FROM UPSTREAM: buzz inherits stderr so child logs land
            // in the harness terminal. HQ Sync is a GUI app launched from
            // Finder/Dock — there is no terminal to inherit, and an inherited
            // handle would send child noise to the app's own stderr. Worse,
            // piping stderr and *not* draining it deadlocks the child once the
            // pipe buffer fills. So: pipe it, and drain it on a background task
            // into the HQ diagnostic log (below).
            .stderr(Stdio::piped())
            // Best-effort cleanup if the value is dropped without shutdown().
            // Callers MUST still call shutdown().await for guaranteed reaping.
            .kill_on_drop(true);

        // Scrub first: `env` is operator-wins and so can never *clear* an
        // inherited variable. Anything the caller needs the child to start
        // without has to be removed from the command explicitly.
        for key in &launch.env_remove {
            cmd.env_remove(key);
        }

        // Operator-wins precedence: never override a key the operator already
        // set in the parent environment. A key we just scrubbed does not count
        // as inherited — it is gone from the child either way, so an explicit
        // value for it must still apply.
        for (key, value) in &launch.env {
            let inherited = std::env::var(key).is_ok();
            let scrubbed = launch.env_remove.iter().any(|k| k == key);
            if !inherited || scrubbed {
                cmd.env(key, value);
            }
        }
        // PATH is the exception and is always forced. A Tauri app launched from
        // Finder/Dock inherits launchd's minimal PATH (roughly
        // `/usr/bin:/bin:/usr/sbin:/sbin`), so a child that shells out to
        // `node`, `claude`, or `codex` would fail with exit 127. See
        // `paths::child_path`.
        cmd.env("PATH", paths::child_path());

        // Own process group so a later group-kill reaps the child *and* the
        // MCP servers and tool processes it spawned, rather than orphaning them
        // to init. On Unix the child's pid then equals its pgid.
        #[cfg(unix)]
        cmd.process_group(0);

        // Suppress the console window Windows allocates for console-subsystem
        // children spawned from a GUI parent.
        paths::no_window_tokio(&mut cmd);

        let mut child = cmd.spawn()?;
        let pid = child.id();

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| StdioError::Protocol("failed to open child stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| StdioError::Protocol("failed to open child stdout".into()))?;

        if let Some(stderr) = child.stderr.take() {
            let tag = handle.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncBufReadExt;
                let mut lines = tokio::io::BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    logfile::log("STDIO_STDERR", &format!("[{tag}] {trimmed}"));
                }
            });
        }

        if let (Some(reg), Some(pid)) = (process_registrar.as_ref(), pid) {
            reg.register(&handle, pid);
        }

        // Windows has no process groups, so the tree-kill primitive is a Job
        // Object with KILL_ON_JOB_CLOSE. Created here (after `register`, which
        // is what puts the entry in the host registry) and handed to the
        // registrar, so the app's `terminate_all_for_exit` drain terminates the
        // child's whole tree through the same path it uses for its own
        // children. Mirrors `commands/process.rs`'s `ChildContainment`.
        #[cfg(target_os = "windows")]
        let (job_handle, owns_job_handle) = match child.raw_handle() {
            Some(raw) => match job_object::create_and_assign(raw) {
                Ok(job) => match process_registrar.as_ref() {
                    Some(reg) => {
                        reg.register_job(&handle, job);
                        (Some(job), false)
                    }
                    None => (Some(job), true),
                },
                Err(e) => {
                    logfile::log(
                        "STDIO_SPAWN",
                        &format!("handle={handle} job object setup failed: {e}"),
                    );
                    (None, false)
                }
            },
            None => (None, false),
        };

        logfile::log(
            "STDIO_SPAWN",
            &format!(
                "handle={handle} pid={pid:?} program={} cwd={}",
                launch.program,
                launch.cwd.display()
            ),
        );

        Ok(Self {
            handle,
            child,
            process_registrar,
            stdin: Some(stdin),
            reader: FramedRead::new(stdout, LinesCodec::new_with_max_length(MAX_LINE_SIZE)),
            next_id: 0,
            pid,
            event_sink: None,
            #[cfg(target_os = "windows")]
            job_handle,
            #[cfg(target_os = "windows")]
            owns_job_handle,
        })
    }

    /// The process-registry handle for this child.
    pub fn handle(&self) -> &str {
        &self.handle
    }

    /// The child's OS pid, if it was spawned successfully.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Attach (or clear) a streaming observer that sees every inbound frame
    /// verbatim, as it arrives, rather than waiting for a driver to finish.
    pub fn set_event_sink(&mut self, tx: Option<UnboundedSender<serde_json::Value>>) {
        self.event_sink = tx;
    }

    fn emit(&self, frame: &serde_json::Value) {
        if let Some(tx) = &self.event_sink {
            // A closed receiver is normal (the UI went away); never fail a read
            // over an observer.
            let _ = tx.send(frame.clone());
        }
    }

    // ── teardown ────────────────────────────────────────────────────────────

    /// Kill the child's whole process tree and reap it (no zombies, no
    /// orphans), then leave the host process registry.
    ///
    /// `Drop` can only do a best-effort synchronous kill; **this is the
    /// guaranteed path** and callers should use it.
    ///
    /// The registry entry is released **only when the child was actually
    /// reaped**. A reap that times out is precisely the case where the process
    /// is most likely still alive, so the entry is deliberately left in place
    /// and the app's `terminate_all_for_exit` drain gets a second pass at it.
    pub async fn shutdown(&mut self) {
        let _ = self.shutdown_with_reap(REAP_TIMEOUT).await;
    }

    /// [`StdioChild::shutdown`] with a caller-supplied reap budget.
    ///
    /// Returns `true` when the child was reaped (and the registry entry
    /// released), `false` when the reap timed out and the child was abandoned
    /// to the exit drain. The budget is a parameter purely so a test can
    /// observe both branches: a real `SIGKILL` never reliably loses a
    /// five-second race, so the abandoning branch is otherwise unreachable
    /// from a test.
    pub async fn shutdown_with_reap(&mut self, reap_budget: Duration) -> bool {
        // Windows: terminate the Job Object first. Its KILL_ON_JOB_CLOSE limit
        // makes it the tree-kill primitive `kill_process_group` cannot be here,
        // so this — not `start_kill` — is what stops the MCP servers and tool
        // processes the child spawned.
        #[cfg(target_os = "windows")]
        if let Some(job) = self.job_handle {
            job_object::terminate(job);
        }

        // Kill the entire process group when possible. The child was spawned
        // with process_group(0), so its pid == its pgid. Killing the group
        // ensures subprocesses (MCP servers, tool processes) are cleaned up
        // rather than orphaned to init.
        //
        // Falls back to start_kill() (direct child only) on non-Unix, or if
        // the child has already been polled to completion (id() returns None).
        match self.child.id() {
            Some(pid) if kill_process_group(pid) => {}
            _ => {
                let _ = self.child.start_kill();
            }
        }

        // Bounded wait: if the child doesn't exit within the budget after
        // SIGKILL, give up and let Drop / the OS handle it. An unbounded wait
        // here would wedge a supervisor during respawn or app shutdown.
        let reaped = match tokio::time::timeout(reap_budget, self.child.wait()).await {
            Ok(Ok(_)) => true,
            Ok(Err(e)) => {
                // The child is unwaitable (already reaped elsewhere, or a
                // broken handle). Nothing further to wait for, so the entry
                // has no second pass to gain by staying.
                logfile::log(
                    "STDIO_SHUTDOWN",
                    &format!("handle={} child wait error after kill: {e}", self.handle),
                );
                true
            }
            Err(_) => {
                logfile::log(
                    "STDIO_SHUTDOWN",
                    &format!(
                        "handle={} child did not exit within {reap_budget:?} after SIGKILL — \
                         abandoning it to the app exit drain (registry entry kept)",
                        self.handle
                    ),
                );
                false
            }
        };

        if reaped {
            self.release_to_host();
        }
        reaped
    }

    /// Leave the host process registry and release any platform teardown
    /// handle we still own. Called only once the child is known to be gone.
    fn release_to_host(&mut self) {
        if let Some(reg) = self.process_registrar.take() {
            reg.deregister(&self.handle);
        }
        #[cfg(target_os = "windows")]
        if let Some(job) = self.job_handle.take() {
            // Only close what we own — when a registrar took the handle at
            // spawn time, the `deregister` above already closed it.
            if self.owns_job_handle {
                job_object::close(job);
            }
        }
    }

    // ── transport ───────────────────────────────────────────────────────────

    /// Signal end-of-input by closing the child's stdin, and let it exit on its
    /// own terms.
    ///
    /// This is the graceful counterpart to [`StdioChild::shutdown`]: a
    /// `stream-json` CLI reads turns from stdin until EOF, then finishes its
    /// current work, writes its final frames, flushes its transcript, and
    /// exits. `shutdown` SIGKILLs the process group instead, which is the right
    /// answer for a wedged child and the wrong one for a session the user just
    /// closed. Idempotent; every later write fails with
    /// [`StdioError::Protocol`] rather than panicking on a missing pipe.
    pub async fn close_stdin(&mut self) {
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.shutdown().await;
        }
    }

    /// Wait up to `budget` for the child to exit on its own and report how it
    /// did, releasing the host registry entry when it is genuinely gone.
    ///
    /// Pairs with [`StdioChild::close_stdin`] (and with a clean stdout EOF):
    /// the driver has already seen the child stop talking and wants the exit
    /// code for the transcript, not a kill. `None` means the child outlived the
    /// budget or was unwaitable — the caller should fall back to
    /// [`StdioChild::shutdown`], which is the guaranteed path.
    pub async fn wait_for_exit(&mut self, budget: Duration) -> Option<std::process::ExitStatus> {
        match tokio::time::timeout(budget, self.child.wait()).await {
            Ok(Ok(status)) => {
                self.release_to_host();
                Some(status)
            }
            Ok(Err(e)) => {
                logfile::log(
                    "STDIO_EXIT",
                    &format!("handle={} wait failed: {e}", self.handle),
                );
                None
            }
            Err(_) => None,
        }
    }

    /// Write one NDJSON line to the child's stdin, bounded by [`WRITE_TIMEOUT`].
    pub async fn write_ndjson(&mut self, value: &serde_json::Value) -> Result<(), StdioError> {
        self.write_ndjson_by(value, None).await
    }

    /// [`StdioChild::write_ndjson`], additionally clamped to `cap`.
    ///
    /// **Why the clamp exists.** A write issued from inside a read loop that is
    /// enforcing a hard deadline (a driver replying mid-turn) would, bounded
    /// only by [`WRITE_TIMEOUT`], be able to run 30s past that deadline and
    /// make "hard" a misnomer. Passing the loop's `hard_deadline` as `cap`
    /// keeps the promise literal: the effective bound is
    /// `min(now + WRITE_TIMEOUT, cap)`.
    pub async fn write_ndjson_by(
        &mut self,
        value: &serde_json::Value,
        cap: Option<tokio::time::Instant>,
    ) -> Result<(), StdioError> {
        let line = serde_json::to_string(value)?;

        let now = tokio::time::Instant::now();
        let deadline = match cap {
            Some(cap) => (now + WRITE_TIMEOUT).min(cap),
            None => now + WRITE_TIMEOUT,
        };
        // Report the budget that actually applied, not the nominal constant —
        // a clamped write that gives up after 2s must not claim it waited 30s.
        let budget = deadline.saturating_duration_since(now);

        // The error stays `WriteTimeout` even when it was `cap` that fired, not
        // WRITE_TIMEOUT. That is the honest classification either way: these
        // lines are a few hundred bytes to a live reader, so the only way one
        // fails to complete is a full pipe buffer — i.e. a child that has
        // genuinely stopped draining its stdin. Only the duration differs, and
        // that is what `budget` carries.

        let Some(stdin) = self.stdin.as_mut() else {
            return Err(StdioError::Protocol(
                "child stdin is closed — the session is ending".into(),
            ));
        };

        tokio::time::timeout_at(deadline, async {
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;
            Ok::<(), std::io::Error>(())
        })
        .await
        .map_err(|_| StdioError::WriteTimeout(budget))?
        .map_err(StdioError::Io)?;
        Ok(())
    }

    /// Send a JSON-RPC request and wait for the matching response.
    ///
    /// Kept in this protocol-agnostic file because a JSON-RPC driver (Codex)
    /// needs exactly this id pairing over exactly this transport, and the
    /// pairing is the only part of JSON-RPC that has to know the read loop's
    /// internals.
    ///
    /// The write phase is bounded by [`WRITE_TIMEOUT`] (30s) and the read phase
    /// by [`REQUEST_TIMEOUT`] (60s), so worst-case wall clock is ~90s.
    pub async fn send_request(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, StdioError> {
        let id = self.next_id;
        self.next_id += 1;

        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        // We cannot borrow `self` mutably across two awaits inside one
        // `timeout()`, so the two phases are sequenced with early return.
        match tokio::time::timeout(REQUEST_TIMEOUT, self.write_ndjson(&msg)).await {
            Ok(result) => result?,
            Err(_) => return Err(StdioError::Timeout(REQUEST_TIMEOUT)),
        }

        match tokio::time::timeout(REQUEST_TIMEOUT, self.read_until_response(id)).await {
            Ok(result) => result,
            Err(_) => Err(StdioError::Timeout(REQUEST_TIMEOUT)),
        }
    }

    /// Send a JSON-RPC **notification** — no `id` field, no response expected.
    /// The absence of `id` is the JSON-RPC 2.0 distinguisher.
    pub async fn send_notification(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), StdioError> {
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_ndjson(&msg).await
    }

    /// Read one line from the framed reader, mapping codec errors to
    /// [`StdioError`].
    ///
    /// `Ok(None)` is never returned — a closed stream is
    /// [`StdioError::AgentExited`].
    pub async fn next_line(&mut self) -> Result<String, StdioError> {
        match self.reader.next().await {
            None => Err(StdioError::AgentExited),
            Some(Err(LinesCodecError::MaxLineLengthExceeded)) => Err(max_line_exceeded_error()),
            Some(Err(e)) => Err(StdioError::Io(std::io::Error::other(e))),
            Some(Ok(line)) => Ok(line),
        }
    }

    /// Parse one raw line; `None` means "skip it" (blank or non-JSON).
    fn parse_line(&self, trimmed: &str) -> Option<serde_json::Value> {
        if trimmed.is_empty() {
            return None;
        }
        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(v) => Some(v),
            Err(e) => {
                logfile::log(
                    "STDIO_WIRE",
                    &format!("handle={} unparseable line skipped: {e}", self.handle),
                );
                None
            }
        }
    }

    /// Does `msg` complete request `expected_id`? A `method` field means it is
    /// a child-initiated request, not a response, even if the id collides.
    pub fn is_response_to(msg: &serde_json::Value, expected_id: u64) -> bool {
        msg.get("method").is_none()
            && msg
                .get("id")
                .is_some_and(|id| *id == serde_json::json!(expected_id))
    }

    /// Read frames until the JSON-RPC response matching `expected_id` arrives,
    /// returning its `result` (or `Null` when it carries none). Every other
    /// frame is emitted to the event sink and skipped.
    ///
    /// This loop has **no idle notion to keep honest**: it is bounded only from
    /// the outside, by the single absolute [`REQUEST_TIMEOUT`] its caller
    /// ([`StdioChild::send_request`]) wraps it in. There is no deadline in here
    /// for a blank or unparseable line to wrongly leave un-reset — the
    /// activity-reset rule belongs solely to [`StdioChild::next_frame`], which
    /// is the loop that classifies idle vs. hard.
    ///
    /// A JSON-RPC `error` object surfaces as [`StdioError::Protocol`] carrying
    /// the object verbatim: what a particular error code *means* is the
    /// driver's business, not the transport's, so no code is interpreted here.
    pub async fn read_until_response(
        &mut self,
        expected_id: u64,
    ) -> Result<serde_json::Value, StdioError> {
        loop {
            let line = self.next_line().await?;
            let Some(msg) = self.parse_line(line.trim()) else {
                continue;
            };
            self.emit(&msg);

            if Self::is_response_to(&msg, expected_id) {
                if let Some(error) = msg.get("error") {
                    return Err(StdioError::Protocol(format!(
                        "child returned a JSON-RPC error for request {expected_id}: {error}"
                    )));
                }
                return Ok(msg
                    .get("result")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null));
            }
        }
    }

    /// Read the next JSON frame from the child's stdout, under two deadlines.
    ///
    /// - `Ok(Some(frame))` — one parsed JSON value.
    /// - `Ok(None)` — the child's stdout reached clean EOF. Whether that is
    ///   normal (a `stream-json` CLI exits after its final frame) or a crash
    ///   (a long-lived JSON-RPC server) is the driver's call, which is why it
    ///   is not an error here. The JSON-RPC path,
    ///   [`StdioChild::read_until_response`], *does* treat EOF as
    ///   [`StdioError::AgentExited`], because a response it is still waiting
    ///   for can no longer arrive.
    ///
    /// The two bounds:
    ///
    /// - `idle_timeout` — silent-child guard, **reset on any inbound wire
    ///   activity**: every successfully-read line counts, including blank and
    ///   unparseable ones, because bytes on stdout mean the child is alive.
    ///   It is a duration rather than an instant precisely so the reset can
    ///   recompute the deadline mid-call, across lines this method skips.
    /// - `hard_deadline` — absolute wall-clock cap on the whole call, passed in
    ///   as an `Instant` so a follow-up drain can inherit the remaining budget
    ///   of the original turn rather than starting a fresh timer.
    pub async fn next_frame(
        &mut self,
        idle_timeout: Duration,
        hard_deadline: tokio::time::Instant,
    ) -> Result<Option<serde_json::Value>, StdioError> {
        use tokio::time::Instant;

        let now = Instant::now();
        let mut idle_deadline = now + idle_timeout;
        let mut last_activity_at = now;

        loop {
            // Classify which deadline fires first BEFORE sleeping — this is the
            // classification used on timeout, immune to scheduler jitter.
            let idle_fires_first = idle_deadline < hard_deadline;
            let next_deadline = if idle_fires_first {
                idle_deadline
            } else {
                hard_deadline
            };

            // PRE-SELECT DEADLINE CHECK. Under `biased`, a continuously-ready
            // reader arm wins every poll and `sleep_until(next_deadline)` is
            // never reached — silently defeating the hard-deadline guarantee
            // for a child that keeps producing output. Checking the classified
            // deadline here keeps a steady-stream child bounded.
            if Instant::now() >= next_deadline {
                return Err(self.timeout_error(idle_fires_first, idle_timeout, last_activity_at));
            }

            let read_result = tokio::select! {
                biased;
                read_result = self.reader.next() => read_result,
                _ = tokio::time::sleep_until(next_deadline) => {
                    // The pre-select check would catch this next iteration
                    // anyway; firing here makes the wakeup immediate when
                    // stdout is idle (no extra reader poll round-trip).
                    return Err(self.timeout_error(idle_fires_first, idle_timeout, last_activity_at));
                }
            };

            let line = match read_result {
                None => return Ok(None),
                Some(Err(LinesCodecError::MaxLineLengthExceeded)) => {
                    return Err(max_line_exceeded_error())
                }
                Some(Err(e)) => return Err(StdioError::Io(std::io::Error::other(e))),
                Some(Ok(line)) => line,
            };

            // ACTIVITY IS THE LINE, NOT THE PARSE. Reset before the blank-line
            // and parse checks below, both of which `continue`. A child that
            // interleaves banner text, progress noise, or malformed frames with
            // its JSON is *not idle* — its stdout is hot. Resetting only on a
            // successful parse would classify a chatty-but-noisy child as
            // silent and return `IdleTimeout` from the one code path whose job
            // is to tell idle apart from a hard timeout.
            let activity_now = Instant::now();
            idle_deadline = activity_now + idle_timeout;
            last_activity_at = activity_now;

            let Some(msg) = self.parse_line(line.trim()) else {
                continue;
            };
            self.emit(&msg);
            return Ok(Some(msg));
        }
    }

    fn timeout_error(
        &self,
        idle_fires_first: bool,
        idle_timeout: Duration,
        last_activity_at: tokio::time::Instant,
    ) -> StdioError {
        if idle_fires_first {
            logfile::log(
                "STDIO_TIMEOUT",
                &format!("handle={} idle timeout ({idle_timeout:?})", self.handle),
            );
            StdioError::IdleTimeout(idle_timeout)
        } else {
            let silence = tokio::time::Instant::now().saturating_duration_since(last_activity_at);
            logfile::log(
                "STDIO_TIMEOUT",
                &format!("handle={} hard timeout (silence {silence:?})", self.handle),
            );
            StdioError::HardTimeout { silence }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Teardown primitives
// ─────────────────────────────────────────────────────────────────────────────

impl Drop for StdioChild {
    fn drop(&mut self) {
        // Best-effort tree kill + reap. We cannot `await` in Drop, so this is a
        // safety net, not the contract: `shutdown().await` is the guaranteed
        // path and every supervisor-managed teardown uses it.
        #[cfg(target_os = "windows")]
        if let Some(job) = self.job_handle {
            job_object::terminate(job);
        }

        match self.child.id() {
            Some(pid) if kill_process_group(pid) => {}
            _ => {
                let _ = self.child.start_kill();
            }
        }
        // Non-blocking reap attempt — avoids zombie accumulation in the common
        // case where SIGKILL lands before Drop returns.
        let _ = self.child.try_wait();

        // Unconditional here, unlike `shutdown`: the value is going away, so
        // there is nothing left to make a second attempt with. Note this is a
        // no-op when `shutdown` already released the entry, which is what keeps
        // the Windows job handle from being closed twice.
        self.release_to_host();
    }
}

/// SIGKILL an entire process group. Returns `true` if the signal was sent.
///
/// The child is spawned with `process_group(0)`, so its pid equals its pgid;
/// signalling the negated pid targets the whole group. Killing the group means
/// the child's own children (MCP servers, tool processes) die with it instead
/// of being orphaned to init across repeated crash-recovery cycles.
///
/// Mirrors `apps/sync/src-tauri/src/commands/process.rs::terminate_pids_for_exit`
/// so stdio teardown and the app's exit drain use one signalling convention.
///
/// Uses `libc` directly rather than `nix`: the crate already depends on `libc`
/// for exactly these two desktop Unix targets, and a second POSIX wrapper would
/// be a dependency bought for one call.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn kill_process_group(pid: u32) -> bool {
    // SAFETY: `kill(2)` with a negated pid and SIGKILL. Both arguments are
    // plain integers, there is no pointer or lifetime involved, and failure
    // (ESRCH/EPERM) is reported through the return value rather than UB.
    unsafe { libc::kill(-(pid as i32), libc::SIGKILL) == 0 }
}

/// Fallback for targets without the process-group signal above: there is no
/// group signal to send here, so this always returns `false` and the caller
/// falls back to `child.start_kill()`, which kills the child **only**.
///
/// On Windows the tree kill is not this function's job at all — it is the Job
/// Object created in [`StdioChild::spawn`] (see [`job_object`]), terminated in
/// [`StdioChild::shutdown`] and `Drop`, and registered with the host process
/// registry so `terminate_all_for_exit` terminates it too. On any other target
/// there is no tree kill and the child's children *are* orphaned; no such
/// target is shipped.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn kill_process_group(_pid: u32) -> bool {
    false
}

/// Windows tree-kill primitive: a Job Object with `KILL_ON_JOB_CLOSE`.
///
/// Windows has no process groups, so the `process_group(0)` + negated-pid
/// signal convention `kill_process_group` uses on Unix has no equivalent.
/// A Job Object does the same job: every process the child spawns inherits
/// membership, so terminating the job takes the MCP servers and tool processes
/// with it instead of orphaning them.
///
/// Deliberately a mechanical mirror of
/// `apps/sync/src-tauri/src/commands/process.rs`'s `create_kill_on_close_job` /
/// `ChildContainment::establish` — the two must not drift, and the handle
/// produced here is handed to that same registry.
///
/// Known limitation, shared with the mirrored code: the child is spawned
/// running rather than suspended, so anything it manages to fork in the window
/// before `AssignProcessToJobObject` escapes the job. Closing that window needs
/// `CREATE_SUSPENDED` + `ResumeThread`, which `std`/`tokio` do not expose, and
/// a CLI has not finished its own startup that fast. Fixing it is a change for
/// both call sites at once, not this one.
#[cfg(target_os = "windows")]
mod job_object {
    use std::os::windows::io::RawHandle;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// Create an anonymous job whose members die when the last handle closes.
    ///
    /// # Safety
    /// Calls the Win32 job-object APIs; the returned handle is owned by the
    /// caller, which must eventually `CloseHandle` it.
    unsafe fn create_kill_on_close_job() -> Result<HANDLE, String> {
        let job = CreateJobObjectW(None, PCWSTR::null())
            .map_err(|e| format!("CreateJobObjectW failed: {e}"))?;

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .map_err(|e| {
            let _ = CloseHandle(job);
            format!("SetInformationJobObject (KILL_ON_JOB_CLOSE) failed: {e}")
        })?;

        Ok(job)
    }

    /// Create a job and put `process` in it, returning the raw job handle.
    pub fn create_and_assign(process: RawHandle) -> Result<isize, String> {
        unsafe {
            let job = create_kill_on_close_job()?;
            match AssignProcessToJobObject(job, HANDLE(process)) {
                Ok(()) => Ok(job.0 as isize),
                Err(e) => {
                    let _ = CloseHandle(job);
                    Err(format!("AssignProcessToJobObject failed: {e}"))
                }
            }
        }
    }

    /// Kill every process in the job. Errors are ignored: the job may already
    /// be gone, and teardown must not fail.
    pub fn terminate(job: isize) {
        unsafe {
            let _ = TerminateJobObject(HANDLE(job as *mut std::ffi::c_void), 1);
        }
    }

    /// Release our handle to the job. Only call this for a job no other owner
    /// (i.e. the host process registry) is going to close.
    pub fn close(job: isize) {
        unsafe {
            let _ = CloseHandle(HANDLE(job as *mut std::ffi::c_void));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
pub(crate) mod test_fakes {
    //! Shell-script fake children, following buzz's `spawn_script` pattern.
    //!
    //! A fake is a bash script that speaks just enough NDJSON to exercise a
    //! real [`StdioChild`] against a real subprocess — real pipes, real process
    //! groups, real EOF. No network, no vendor CLI.

    use super::*;
    use std::path::Path;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    /// Env var naming the file a counting fake appends its invocations to.
    ///
    /// Set by [`counting_script_launch`]; when unset (every other test) the
    /// fakes' `count` helper is a no-op, so the scripts stay usable unchanged.
    pub const COUNTER_ENV: &str = "HQ_FAKE_CHILD_COUNTER_FILE";

    /// Serialises the tests that install a *global* process registrar, so one
    /// test's `clear_process_registrar` cannot land between another's spawn and
    /// its shutdown. Nothing else in this file touches global state.
    pub fn registrar_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        // A panicking test poisons the lock; the guarded data is `()`, so
        // recovering is strictly better than cascading unrelated failures.
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// A plain NDJSON echo/stream fake: for every line it reads it emits one
    /// unsolicited `progress` frame and then a frame echoing what it received,
    /// carrying back any numeric `"id":` it found. That single id echo is what
    /// makes one script serve as a JSON-RPC responder
    /// (`{"jsonrpc":"2.0","id":N,"result":{}}`) and as a protocol-free frame
    /// source at once.
    ///
    /// The id is extracted with `sed` scanning for the literal `"id":`, so key
    /// order in the caller's JSON is irrelevant.
    ///
    /// Every line is recorded through the script's `count` helper, which
    /// appends one line per invocation to `$HQ_FAKE_CHILD_COUNTER_FILE` (see
    /// [`counting_script_launch`]; with the var unset the helper is a no-op).
    /// Each `count` runs *before* the matching response is written, so a caller
    /// that has observed the response has necessarily already observed the
    /// count on disk — [`invocation_count`] needs no sleeping to be race-free.
    pub const ECHO_SCRIPT: &str = r#"
count() {
  if [ -n "$HQ_FAKE_CHILD_COUNTER_FILE" ]; then
    printf '%s\n' "$1" >> "$HQ_FAKE_CHILD_COUNTER_FILE"
  fi
}
while IFS= read -r line; do
  count line
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  printf '{"jsonrpc":"2.0","method":"progress","params":{"seen":true}}\n'
  if [ -n "$id" ]; then
    printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"
  else
    printf '{"echo":true}\n'
  fi
done
"#;

    /// Build a [`StdioLaunch`] that runs `script` under bash.
    pub fn script_launch(script: &str) -> StdioLaunch {
        StdioLaunch {
            program: "bash".to_string(),
            args: vec!["-c".to_string(), script.to_string()],
            env: Vec::new(),
            env_remove: Vec::new(),
            cwd: std::env::temp_dir(),
        }
    }

    /// Like [`script_launch`], but points the fake's `count` helper at
    /// `counter_file` so the test can assert how many lines it actually served.
    ///
    /// `counter_file` should live in the test's own `TempDir` — the fake only
    /// ever appends, so a shared path would blend runs together.
    pub fn counting_script_launch(script: &str, counter_file: &Path) -> StdioLaunch {
        let mut launch = script_launch(script);
        launch.env.push((
            COUNTER_ENV.to_string(),
            counter_file.to_string_lossy().into_owned(),
        ));
        launch
    }

    /// How many times the fake recorded `kind`. A missing file means zero —
    /// the fake never got that far.
    pub fn invocation_count(counter_file: &Path, kind: &str) -> usize {
        std::fs::read_to_string(counter_file)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.trim() == kind)
            .count()
    }

    /// Spawn a fake child from an inline bash script.
    pub async fn spawn_script(script: &str) -> StdioChild {
        StdioChild::spawn(&script_launch(script))
            .await
            .expect("failed to spawn fake child")
    }
}

#[cfg(test)]
mod tests {
    use super::test_fakes::*;
    use super::*;

    fn idle() -> Duration {
        Duration::from_secs(10)
    }

    fn hard() -> tokio::time::Instant {
        tokio::time::Instant::now() + Duration::from_secs(30)
    }

    /// Probe existence without delivering a signal (signal 0).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn alive(pid: u32) -> bool {
        // SAFETY: `kill(2)` with signal 0 performs the permission/existence
        // check only; no signal is delivered and no memory is touched.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    /// Bounded wait for a fake to report a pid it forked.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    async fn wait_for_pidfile(pidfile: &std::path::Path) -> u32 {
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(pidfile) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    return pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("fake child never reported a pid in {}", pidfile.display());
    }

    /// Bounded wait for the OS to deliver SIGKILL and reap `pid`.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    async fn wait_until_gone(pid: u32) -> bool {
        for _ in 0..100 {
            if !alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    // ── environment scrub ───────────────────────────────────────────────────

    /// Restores a process-global variable on drop, so a panicking assertion
    /// cannot leak the override into a later test in this binary.
    struct ScopedVar(&'static str, Option<std::ffi::OsString>);

    impl ScopedVar {
        fn set(key: &'static str, value: &str) -> Self {
            let prev = std::env::var_os(key);
            std::env::set_var(key, value);
            Self(key, prev)
        }
    }

    impl Drop for ScopedVar {
        fn drop(&mut self) {
            match self.1.take() {
                Some(v) => std::env::set_var(self.0, v),
                None => std::env::remove_var(self.0),
            }
        }
    }

    /// Report both variables back as one JSON frame; an unset variable comes
    /// back as the empty string rather than tripping `set -u`.
    const ENV_REPORT_SCRIPT: &str = r#"
printf '{"scrubbed":"%s","kept":"%s"}\n' "${HQ_TEST_SCRUB_ME-}" "${HQ_TEST_KEEP_ME-}"
while IFS= read -r _line; do :; done
"#;

    /// `env` is operator-wins and therefore cannot clear anything. `env_remove`
    /// is the only way to keep an inherited variable — a `CLAUDECODE` leaking
    /// out of the shell that started a dev build, say — away from the child.
    ///
    /// The env lock is deliberately held across the spawns: a child snapshots
    /// the parent environment at `spawn`, so releasing it earlier would let a
    /// parallel test in this binary mutate the very thing under test.
    #[tokio::test]
    #[allow(clippy::await_holding_lock, reason = "serializes process-global env")]
    async fn env_remove_clears_an_inherited_variable_and_leaves_the_rest_alone() {
        let _guard = crate::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _scrub = ScopedVar::set("HQ_TEST_SCRUB_ME", "leaked");
        let _keep = ScopedVar::set("HQ_TEST_KEEP_ME", "kept");

        // Unlisted: the child inherits both, which is what makes the scrub in
        // the next case attributable to `env_remove` and nothing else.
        let mut child = StdioChild::spawn(&script_launch(ENV_REPORT_SCRIPT))
            .await
            .expect("spawn");
        let frame = child
            .next_frame(idle(), hard())
            .await
            .expect("frame")
            .expect("a frame");
        assert_eq!(
            frame["scrubbed"], "leaked",
            "without env_remove the child inherits the parent's value"
        );
        assert_eq!(frame["kept"], "kept");
        child.shutdown_with_reap(REAP_TIMEOUT).await;

        // Listed: gone from the child even though the parent still has it.
        let mut launch = script_launch(ENV_REPORT_SCRIPT);
        launch.env_remove.push("HQ_TEST_SCRUB_ME".to_string());
        let mut child = StdioChild::spawn(&launch).await.expect("spawn");
        let frame = child
            .next_frame(idle(), hard())
            .await
            .expect("frame")
            .expect("a frame");
        assert_eq!(
            frame["scrubbed"], "",
            "env_remove must clear the inherited value"
        );
        assert_eq!(
            frame["kept"], "kept",
            "and must not disturb anything it did not name"
        );
        assert_eq!(
            std::env::var("HQ_TEST_SCRUB_ME").as_deref(),
            Ok("leaked"),
            "the scrub is per-child; the parent's own env is untouched"
        );
        child.shutdown_with_reap(REAP_TIMEOUT).await;
    }

    /// A name in both lists is well defined: the removal happens first, so the
    /// explicit value wins over the inherited one that operator-wins would
    /// otherwise have preserved.
    #[tokio::test]
    #[allow(clippy::await_holding_lock, reason = "serializes process-global env")]
    async fn env_wins_over_an_inherited_value_when_the_name_is_also_scrubbed() {
        let _guard = crate::test_support::ENV_MUTEX
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _scrub = ScopedVar::set("HQ_TEST_SCRUB_ME", "leaked");
        let _keep = ScopedVar::set("HQ_TEST_KEEP_ME", "kept");

        let mut launch = script_launch(ENV_REPORT_SCRIPT);
        launch.env_remove.push("HQ_TEST_SCRUB_ME".to_string());
        launch
            .env
            .push(("HQ_TEST_SCRUB_ME".to_string(), "explicit".to_string()));
        // Not scrubbed, so plain operator-wins still applies here.
        launch
            .env
            .push(("HQ_TEST_KEEP_ME".to_string(), "ignored".to_string()));

        let mut child = StdioChild::spawn(&launch).await.expect("spawn");
        let frame = child
            .next_frame(idle(), hard())
            .await
            .expect("frame")
            .expect("a frame");
        assert_eq!(frame["scrubbed"], "explicit");
        assert_eq!(
            frame["kept"], "kept",
            "an un-scrubbed inherited value still beats the launch's env"
        );
        child.shutdown_with_reap(REAP_TIMEOUT).await;
    }

    // ── graceful end-of-input ───────────────────────────────────────────────

    /// The graceful close path: EOF on stdin ends the child, `wait_for_exit`
    /// reports how, and a write after the close is refused rather than
    /// panicking on a taken pipe.
    #[tokio::test]
    async fn close_stdin_ends_the_child_cleanly_and_refuses_later_writes() {
        // Reads until EOF, then exits 7 — proof the exit came from OUR stdin
        // close and not from a kill (a SIGKILL has no exit code).
        let mut child = spawn_script("while IFS= read -r _line; do :; done; exit 7").await;

        child.close_stdin().await;

        // stdout reaches clean EOF, not an error.
        assert_eq!(
            child
                .next_frame(idle(), hard())
                .await
                .expect("clean stream"),
            None,
            "closing stdin ends the stream at EOF"
        );

        let status = child
            .wait_for_exit(Duration::from_secs(5))
            .await
            .expect("child exited within the budget");
        assert_eq!(status.code(), Some(7), "the child chose its own exit code");

        let err = child
            .write_ndjson(&serde_json::json!({"type": "user"}))
            .await
            .expect_err("stdin is gone");
        assert!(
            matches!(&err, StdioError::Protocol(msg) if msg.contains("stdin is closed")),
            "unexpected error: {err:?}"
        );

        // Idempotent: a second close is a no-op, not a panic.
        child.close_stdin().await;
    }

    /// `wait_for_exit` is bounded: a child that ignores EOF and keeps running
    /// must not wedge the caller, and the caller can still fall back to the
    /// guaranteed kill path.
    #[tokio::test]
    async fn wait_for_exit_gives_up_on_a_child_that_outlives_its_budget() {
        let mut child = spawn_script("sleep 30").await;
        assert!(
            child
                .wait_for_exit(Duration::from_millis(200))
                .await
                .is_none(),
            "a still-running child must not be reported as exited"
        );
        assert!(
            child.shutdown_with_reap(REAP_TIMEOUT).await,
            "kill path still works"
        );
    }

    // ── pure-logic tests (no process) ───────────────────────────────────────

    #[test]
    fn crash_class_covers_exactly_the_respawn_worthy_failures() {
        assert!(StdioError::AgentExited.is_crash_class());
        assert!(StdioError::Io(std::io::Error::other("boom")).is_crash_class());
        assert!(StdioError::WriteTimeout(Duration::from_secs(1)).is_crash_class());

        assert!(!StdioError::IdleTimeout(Duration::from_secs(1)).is_crash_class());
        assert!(!StdioError::HardTimeout {
            silence: Duration::from_secs(1)
        }
        .is_crash_class());
        assert!(!StdioError::Timeout(Duration::from_secs(1)).is_crash_class());
        assert!(!StdioError::Protocol("nope".into()).is_crash_class());
    }

    #[test]
    fn the_oversize_error_names_the_cap_it_actually_enforces() {
        let msg = max_line_exceeded_error().to_string();
        assert!(
            msg.contains(&MAX_LINE_SIZE.to_string()),
            "the message must be built from the constant, not a literal that can \
             drift away from it: {msg}"
        );
    }

    #[test]
    fn a_frame_with_a_method_is_never_a_response_even_when_the_id_matches() {
        let response = serde_json::json!({"id": 7, "result": {}});
        let request = serde_json::json!({"id": 7, "method": "child/asks", "params": {}});

        assert!(StdioChild::is_response_to(&response, 7));
        assert!(!StdioChild::is_response_to(&response, 8));
        assert!(
            !StdioChild::is_response_to(&request, 7),
            "a child-initiated request must not be mistaken for our response"
        );
    }

    // ── transport round trips ───────────────────────────────────────────────

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn write_then_read_round_trips_a_frame() {
        let dir = tempfile::tempdir().expect("tempdir");
        let counter = dir.path().join("counter");
        let mut child = StdioChild::spawn(&counting_script_launch(ECHO_SCRIPT, &counter))
            .await
            .expect("spawn");

        child
            .write_ndjson(&serde_json::json!({"hello": "world"}))
            .await
            .expect("write");

        let first = child
            .next_frame(idle(), hard())
            .await
            .expect("read")
            .expect("the fake is still running, so this is not EOF");
        assert_eq!(first["method"], "progress");

        let second = child
            .next_frame(idle(), hard())
            .await
            .expect("read")
            .expect("second frame");
        assert_eq!(second["echo"], true);

        assert_eq!(
            invocation_count(&counter, "line"),
            1,
            "the fake must have read exactly the one line we wrote"
        );

        child.shutdown().await;
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn send_request_pairs_the_response_by_id_and_skips_everything_else() {
        // The fake emits an unsolicited `progress` notification *before* the
        // response to every request, so a client that returned the first frame
        // it saw would fail here. Two requests in a row also prove the id
        // counter advances rather than pairing everything against id 0.
        let mut child = spawn_script(ECHO_SCRIPT).await;

        let first = child
            .send_request("one", serde_json::json!({}))
            .await
            .expect("first request");
        assert_eq!(first, serde_json::json!({}));

        let second = child
            .send_request("two", serde_json::json!({}))
            .await
            .expect("second request");
        assert_eq!(second, serde_json::json!({}));

        child.shutdown().await;
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn the_event_sink_sees_every_inbound_frame_verbatim() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut child = spawn_script(ECHO_SCRIPT).await;
        child.set_event_sink(Some(tx));

        child
            .send_request("observed", serde_json::json!({}))
            .await
            .expect("request");

        let notification = rx.try_recv().expect("the progress notification");
        assert_eq!(notification["method"], "progress");
        let response = rx.try_recv().expect("the response");
        assert_eq!(response["id"], 0);

        child.shutdown().await;
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn send_notification_writes_a_frame_with_no_id() {
        // Proven through the fake's own id-echo branch: with no `"id":` on the
        // line it read, it answers `{"echo":true}` rather than a response.
        let mut child = spawn_script(ECHO_SCRIPT).await;
        child
            .send_notification("fire/forget", serde_json::json!({"n": 1}))
            .await
            .expect("notification");

        let _progress = child.next_frame(idle(), hard()).await.expect("read");
        let echoed = child
            .next_frame(idle(), hard())
            .await
            .expect("read")
            .expect("frame");
        assert_eq!(
            echoed["echo"], true,
            "a notification must carry no id, so the fake takes its no-id branch"
        );

        child.shutdown().await;
    }

    // ── bounded reads ───────────────────────────────────────────────────────

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn oversized_frame_is_rejected_without_oom() {
        // 11MB on one line with no newline. The codec's max-length cap must
        // surface a Protocol error rather than growing the decode buffer
        // unboundedly — assert the error, and note that reaching this
        // assertion at all is the "did not OOM" proof.
        let script = "head -c 11000000 /dev/zero | tr '\\000' 'x'; sleep 5";
        let mut child = spawn_script(script).await;
        let err = child
            .next_frame(idle(), hard())
            .await
            .expect_err("oversized line must be rejected");
        let msg = err.to_string();
        assert!(
            matches!(err, StdioError::Protocol(_)),
            "expected Protocol error, got {err:?}"
        );
        assert!(
            msg.contains(&MAX_LINE_SIZE.to_string()),
            "error must name the actual {MAX_LINE_SIZE}-byte cap, not a hardcoded \
             string that can drift away from it: {msg}"
        );
        child.shutdown().await;
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn a_dead_child_surfaces_agent_exited_on_the_request_path() {
        let mut child = spawn_script("exit 0").await;
        let err = child
            .read_until_response(0)
            .await
            .expect_err("closed stdout must be an error");
        assert!(matches!(err, StdioError::AgentExited), "got {err:?}");
        assert!(err.is_crash_class());
        child.shutdown().await;
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn clean_eof_is_end_of_stream_not_an_error_on_the_frame_path() {
        // A `stream-json` CLI exits after its final frame; that is not a crash,
        // and only the driver knows whether it was expecting more.
        let mut child = spawn_script(r#"printf '{"type":"result"}\n'"#).await;
        let frame = child
            .next_frame(idle(), hard())
            .await
            .expect("read")
            .expect("the one frame");
        assert_eq!(frame["type"], "result");

        assert!(
            child
                .next_frame(idle(), hard())
                .await
                .expect("EOF must not be an error here")
                .is_none(),
            "a closed stdout must read as end-of-stream"
        );
        child.shutdown().await;
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn idle_timeout_fires_on_a_silent_child() {
        let mut child = spawn_script("sleep 30").await;
        let hard_deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let err = child
            .next_frame(Duration::from_millis(120), hard_deadline)
            .await
            .expect_err("silence must time out");
        assert!(matches!(err, StdioError::IdleTimeout(_)), "got {err:?}");
        child.shutdown().await;
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn noisy_non_json_output_counts_as_activity_and_does_not_trip_the_idle_guard() {
        // Regression guard: the idle clock must reset on any line that comes
        // off stdout, not only on lines that parse as JSON. This child is busy
        // and talkative — blank lines and garbage every 200ms — but says
        // nothing well-formed for 2.4s, comfortably past the 1.5s idle budget.
        // Resetting only after a successful parse classifies it as silent and
        // returns IdleTimeout, which is exactly wrong: its stdout never went
        // quiet for more than 200ms.
        let script = r#"
i=0
while [ "$i" -lt 12 ]; do
  printf '\n'
  printf 'npm warn: this is not json at all\n'
  sleep 0.2
  i=$((i+1))
done
printf '{"done":true}\n'
sleep 5
"#;
        let mut child = spawn_script(script).await;

        match child
            .next_frame(
                Duration::from_millis(1500),
                tokio::time::Instant::now() + Duration::from_secs(30),
            )
            .await
        {
            Ok(Some(frame)) => assert_eq!(frame["done"], true),
            Ok(None) => panic!("the fake was still running — EOF is wrong here"),
            Err(StdioError::IdleTimeout(d)) => panic!(
                "a noisy-but-active child was misclassified as idle after {d:?} — the idle \
                 clock is not being reset on unparseable/blank lines"
            ),
            Err(e) => panic!("unexpected error: {e:?}"),
        }

        child.shutdown().await;
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn hard_deadline_beats_a_continuously_chattering_child() {
        // Regression guard for the pre-select deadline check: under `biased`
        // the always-ready reader arm would otherwise starve `sleep_until` and
        // the hard deadline would never fire.
        //
        // The producer must genuinely saturate the pipe. A bash `while true`
        // loop is far slower than the reader, so the pipe keeps running dry,
        // `sleep_until` gets polled normally, and the test would pass with the
        // pre-select check deleted — proving nothing. `yes` writes flat out and
        // keeps the reader arm ready on every poll, which is the condition the
        // check exists for.
        //
        // The chatter is deliberately *not* JSON: `next_frame` returns as soon
        // as one line parses, so a stream of valid frames would leave the loop
        // before any deadline mattered. Unparseable lines keep it spinning
        // inside a single call, which is exactly where the starvation lives.
        let mut child = spawn_script("exec yes 'chatter, and not json'").await;
        let hard_deadline = tokio::time::Instant::now() + Duration::from_millis(150);
        let err = tokio::time::timeout(
            Duration::from_secs(10),
            child.next_frame(Duration::from_secs(60), hard_deadline),
        )
        .await
        .expect("hard deadline must fire even under a constant stdout stream")
        .expect_err("expected a timeout error");
        assert!(matches!(err, StdioError::HardTimeout { .. }), "got {err:?}");
        child.shutdown().await;
    }

    // ── registrar + no-orphan proofs ────────────────────────────────────────

    #[derive(Default)]
    struct FakeRegistrar {
        events: std::sync::Mutex<Vec<(String, String)>>,
    }

    impl FakeRegistrar {
        fn events_for(&self, handle: &str) -> Vec<String> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, h)| h == handle)
                .map(|(kind, _)| kind.clone())
                .collect()
        }
    }

    impl crate::stdio::StdioProcessRegistrar for FakeRegistrar {
        fn register(&self, handle: &str, _pid: u32) {
            self.events
                .lock()
                .unwrap()
                .push(("register".into(), handle.to_string()));
        }
        fn deregister(&self, handle: &str) {
            self.events
                .lock()
                .unwrap()
                .push(("deregister".into(), handle.to_string()));
        }
    }

    // `registrar_lock` is a std `Mutex` deliberately held across awaits: it
    // exists to serialise two `#[tokio::test]`s, each of which owns its own
    // single-threaded runtime on its own thread, so there is no task to block
    // and nothing to deadlock. An async mutex would not serialise them at all.
    #[allow(clippy::await_holding_lock)]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn spawn_registers_and_shutdown_deregisters_the_child() {
        // The unit-level proof of the no-orphan contract: a stdio child joins
        // the same registry the app's exit drain walks, and leaves it on
        // teardown.
        let _guard = registrar_lock();
        let fake = std::sync::Arc::new(FakeRegistrar::default());
        crate::stdio::set_process_registrar(fake.clone());

        let mut child = spawn_script("sleep 5").await;
        let handle = child.handle().to_string();
        assert_eq!(
            fake.events_for(&handle),
            vec!["register".to_string()],
            "spawn must register the child's pid"
        );

        child.shutdown().await;
        assert!(
            fake.events_for(&handle).contains(&"deregister".to_string()),
            "shutdown must deregister the handle"
        );

        drop(child);
        crate::stdio::registrar::clear_process_registrar();
    }

    // A late registrar installation must not steal a live child's teardown.
    #[allow(clippy::await_holding_lock)]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn registrar_replacement_does_not_transfer_a_live_child() {
        let _guard = registrar_lock();
        let original = std::sync::Arc::new(FakeRegistrar::default());
        let replacement = std::sync::Arc::new(FakeRegistrar::default());
        crate::stdio::set_process_registrar(original.clone());
        let mut child = spawn_script("sleep 5").await;
        let handle = child.handle().to_string();
        crate::stdio::set_process_registrar(replacement.clone());
        child.shutdown().await;
        assert_eq!(original.events_for(&handle), vec!["register", "deregister"]);
        assert!(replacement.events_for(&handle).is_empty());
        drop(child);
        crate::stdio::registrar::clear_process_registrar();
    }

    // See the note on `spawn_registers_and_shutdown_deregisters_the_child`.
    #[allow(clippy::await_holding_lock)]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn an_unreaped_child_stays_in_the_registry_for_the_exit_drain() {
        // A reap that times out is the case where the child is most likely
        // STILL ALIVE, so deregistering there removed it from the very list
        // `terminate_all_for_exit` walks — the one mechanism left that could
        // have killed it. The entry must survive so the exit drain gets a
        // second pass; `Drop` still releases it eventually.
        //
        // The reap budget is a parameter here because a real SIGKILL cannot be
        // made to reliably lose a five-second race — but it *can* lose a
        // zero-length one, and whichever way that race falls the assertion
        // below is exact, so this never flakes.
        let _guard = registrar_lock();
        let fake = std::sync::Arc::new(FakeRegistrar::default());
        crate::stdio::set_process_registrar(fake.clone());

        let mut child = spawn_script("sleep 300").await;
        let handle = child.handle().to_string();
        assert_eq!(fake.events_for(&handle), vec!["register".to_string()]);

        let reaped = child.shutdown_with_reap(Duration::ZERO).await;
        let deregistered = fake.events_for(&handle).contains(&"deregister".to_string());

        if reaped {
            assert!(
                deregistered,
                "a child that WAS reaped is gone for good — keeping its entry would \
                 leave the exit drain signalling a recycled pid"
            );
        } else {
            assert!(
                !deregistered,
                "an abandoned child must stay registered so the app exit drain can \
                 have another go at it"
            );
        }

        // Either way the entry is released once the value itself goes away.
        drop(child);
        assert!(
            fake.events_for(&handle).contains(&"deregister".to_string()),
            "Drop is the backstop — nothing may leak permanently"
        );
        crate::stdio::registrar::clear_process_registrar();
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn shutdown_kills_the_whole_process_group_leaving_no_orphan() {
        // The real no-orphan proof: the child forks a long-lived grandchild
        // into its own process group. A plain child kill would orphan it to
        // init; a process-group kill takes it too.
        //
        // Mirrors `commands/process.rs::terminate_pids_for_exit_kills_detached_process_groups`.
        let dir = tempfile::tempdir().expect("tempdir");
        let pidfile = dir.path().join("grandchild.pid");
        let script = format!(
            r#"
sleep 300 &
echo $! > {pidfile}
while IFS= read -r line; do :; done
"#,
            pidfile = pidfile.display()
        );

        let mut child = spawn_script(&script).await;
        let grandchild = wait_for_pidfile(&pidfile).await;
        assert!(
            alive(grandchild),
            "grandchild must be alive before shutdown"
        );

        child.shutdown().await;

        // The grandchild reparents to init on the child's death; give the OS a
        // bounded window to deliver SIGKILL and reap it.
        assert!(
            wait_until_gone(grandchild).await,
            "grandchild {grandchild} survived shutdown — process-group kill did not take"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn drop_leaves_no_live_process() {
        // `shutdown().await` is the contract, but a value dropped without it
        // (a `?` early return on some other error) must not leak a running CLI.
        let child = spawn_script("sleep 300").await;
        let pid = child.pid().expect("pid");
        assert!(alive(pid));

        drop(child);

        assert!(
            wait_until_gone(pid).await,
            "child {pid} survived Drop — the best-effort kill net has a hole"
        );
    }
}
