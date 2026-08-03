use std::collections::HashSet;
use std::io::ErrorKind;
use std::time::Duration;

use crate::events::{SyncCompleteEvent, SyncErrorEvent, SyncEvent};
use sha2::{Digest, Sha256};

// ─────────────────────────────────────────────────────────────────────────────
// Per-run aggregated counters
// ─────────────────────────────────────────────────────────────────────────────

/// Aggregated counters across a single sync run.
///
/// A fresh instance is created per `start_sync` invocation, so totals are
/// scoped to the run — no reset needed between runs. Per-company `Complete`
/// events contribute via `accumulate`; the `AllComplete` handler reads the
/// final totals to build the journal.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunTotals {
    pub conflicts: u32,
    /// Set true when the runner emits AllComplete. Used by the Exit handler
    /// to detect "runner exited without ever finishing the protocol" — e.g.
    /// when it bails on `setup-needed` before reaching the fanout — so we
    /// can emit a synthetic AllComplete and unblock the UI from a stuck
    /// "syncing" state.
    pub all_complete_seen: bool,
    /// Set when the runner emits a terminal auth-error on either protocol
    /// channel. Auth-required is intentionally exit 0, but must never be
    /// overwritten by the manual exit handler's synthetic AllComplete.
    pub saw_auth_error: bool,
    /// Set true when the runner emitted at least one error event of ANY level
    /// (company-level `path == "(company)"` OR per-file). Both drive the
    /// runner's exit-2 path — `hq-cloud`'s `executeCompanyFanout` pushes EVERY
    /// emitted `error` event (incl. gracefully-skipped per-file ACL-scope skips)
    /// into its `errors` tally, and `sync-runner.ts` exits 2 when that tally is
    /// non-empty. The Exit handler uses this together with `saw_alertable_error`
    /// to tell "non-zero exit fully explained by benign errors" apart from
    /// "unexplained crash before any protocol" — only the latter should raise a
    /// Sentry alert.
    ///
    /// Fed from BOTH runner channels: error events arrive on stdout for legacy
    /// runners (via `handle_sync_line` → `accumulate`) and on STDERR for runners
    /// that moved error-class events off the stdout protocol stream (hq-cloud
    /// PR #34 — see the `ProcessEvent::Stderr` arm, which parses + records them).
    pub saw_error: bool,
    /// Set true when at least one observed error was *alertable* — a real defect
    /// rather than a benign not-yet-provisioned 404, a transient self-healing
    /// network blip, or an expected per-file ACL-scope skip. Gates the Sentry
    /// capture at the non-zero-exit site (see `should_alert_on_nonzero_exit`).
    pub saw_alertable_error: bool,
    /// Set true when raw runner stderr carries the Node-too-old startup crash
    /// signature. The runner exits before emitting protocol in this case, so it
    /// would otherwise look like an unexplained crash. It is an environment
    /// fault the user fixes by updating Node, not a defect.
    pub saw_node_too_old: bool,
    /// Set when stderr carries a signature that says the runner itself died
    /// before it could report a normal protocol outcome. This is diagnostic
    /// only: it never changes alerting, but lets the next watcher-exit event
    /// distinguish an indeterminate termination from a fatal runner failure.
    pub saw_fatal_runner_signature: bool,
    /// Content-safe counts of runner error classes seen in this pass. The
    /// watcher attaches only this fixed-vocabulary rollup to a termination
    /// capture; paths and raw messages remain local breadcrumbs.
    pub runner_error_rollup: RunnerErrorRollup,
    /// Content-safe runner operation counts for termination diagnostics. Like
    /// the class rollup, every rendered token is selected in code.
    pub runner_error_ops: RunnerErrorOpRollup,
    /// Raw company names remain process-local only so this can report the
    /// distinct blast radius as a number without ever sending a name.
    runner_error_companies: HashSet<String>,
    /// The last recognised runner-fatal signature in this pass. This is a
    /// content-safe enum token used only as evidence on a termination event;
    /// it must never affect the capture or suppression decision.
    pub runner_fatal_class: RunnerFatalClass,
}

impl RunTotals {
    /// Update totals from a single event. `Complete` events contribute to
    /// counters; `AllComplete` flips the seen-flag; `Error` events feed the
    /// exit-alert decision via `record_error`. Saturates on overflow.
    pub fn accumulate(&mut self, event: &SyncEvent) {
        match event {
            SyncEvent::Complete(c) => {
                self.conflicts = self.conflicts.saturating_add(c.conflicts);
            }
            SyncEvent::AllComplete(_) => {
                self.all_complete_seen = true;
            }
            SyncEvent::AuthError(_) => self.record_auth_error(),
            // Every error event — company-level OR per-file — is counted by the
            // runner toward its non-zero exit, so all of them feed the alert
            // decision here (classified benign-vs-alertable in `record_error`).
            SyncEvent::Error(e) => self.record_error(e),
            _ => {}
        }
    }

    /// Record a single runner error event toward the exit-alert decision,
    /// classifying it benign-vs-alertable. Idempotent in spirit — flags only
    /// flip on, so a later benign error can never "downgrade" a real one seen
    /// earlier in the same run.
    ///
    /// Called for error events arriving on EITHER channel: stdout (legacy
    /// runners) via `accumulate`, and stderr (hq-cloud PR #34, which moved
    /// error-class events off the stdout protocol stream) via the runner's
    /// `ProcessEvent::Stderr` arm. Without the stderr path, post-PR-#34 runs see
    /// zero error events here, `saw_error` stays false, and every non-zero exit
    /// (incl. the very common benign code-2 from ACL-scope skips) falls through
    /// to the "unexplained crash" branch and alerts — the HQ-SYNC-WEB-6 flood.
    pub fn record_error(&mut self, err: &SyncErrorEvent) {
        self.saw_error = true;
        self.runner_error_rollup.record(&err.message);
        self.runner_error_ops.record(&err.message);
        if let Some(company) = err.company.as_deref() {
            self.runner_error_companies.insert(company.to_string());
        }
        if is_alertable_error(err) {
            self.saw_alertable_error = true;
        }
    }

    /// The distinct count is safe telemetry; company names never leave this
    /// process or this private deduplication set.
    pub fn runner_error_company_count(&self) -> u32 {
        u32::try_from(self.runner_error_companies.len()).unwrap_or(u32::MAX)
    }

    pub fn record_auth_error(&mut self) {
        self.saw_auth_error = true;
    }

    /// Record raw runner stderr toward reactive environment-fault
    /// classification. This intentionally does not flip `saw_error`: the
    /// Node-too-old signature is not a runner protocol error, it is the
    /// interpreter failing before the runner can start.
    pub fn record_stderr_line(&mut self, line: &str) {
        if is_node_too_old_signature(line) {
            self.saw_node_too_old = true;
        }
        if is_fatal_runner_signature(line) {
            self.saw_fatal_runner_signature = true;
        }
        let class = classify_runner_fatal_class(line);
        if class != RunnerFatalClass::None {
            self.runner_fatal_class = class;
        }
    }
}

/// Coarse runner work phase shared by manual and watcher telemetry.
///
/// The value is derived only from protocol events emitted by the process being
/// observed. Callers must not consult the shared on-disk progress snapshot,
/// because another route may have written it.
pub fn runner_phase_from_event(event: &SyncEvent) -> Option<&'static str> {
    match event {
        SyncEvent::FanoutPlan(_) | SyncEvent::Plan(_) => Some("scan"),
        SyncEvent::Progress(progress) => Some(match progress.direction.as_deref() {
            Some("up") => "push",
            Some("down") => "pull",
            _ => "unknown",
        }),
        SyncEvent::AllComplete(_) => Some("idle"),
        _ => None,
    }
}

/// Fixed elapsed-time vocabulary shared by both runner routes.
pub fn runner_phase_elapsed_bucket(elapsed: Duration) -> &'static str {
    match elapsed.as_secs() {
        0..=59 => "under_1m",
        60..=299 => "1m_to_5m",
        300..=1799 => "5m_to_30m",
        1800..=7199 => "30m_to_2h",
        _ => "over_2h",
    }
}

/// Fixed stack-shape tokens that are safe to leave the process boundary.
pub const RUNNER_STACK_TOKENS: &[&str] = &[
    "app",
    "libuv_handle",
    "libuv_win_async",
    "libuv_unix_core",
    "node_task_queues",
    "node_cjs_loader",
    "node_esm_loader",
    "node_timers",
    "node_child_process",
    "node_events",
    "node_fs",
    "node_stream",
    "rust_core_panicking",
    "rust_std_panicking",
];

const RUNTIME_FRAME_TABLE: &[(&str, &str)] = &[
    ("uv_handle", "libuv_handle"),
    (r"src\win\async.c", "libuv_win_async"),
    ("src/win/async.c", "libuv_win_async"),
    ("src/unix/core.c", "libuv_unix_core"),
    ("node:internal/process/task_queues", "node_task_queues"),
    ("node:internal/modules/cjs/loader", "node_cjs_loader"),
    ("node:internal/modules/esm/loader", "node_esm_loader"),
    ("node:internal/timers", "node_timers"),
    ("node:internal/child_process", "node_child_process"),
    ("node:events", "node_events"),
    ("node:fs", "node_fs"),
    ("node:stream", "node_stream"),
    ("core::panicking", "rust_core_panicking"),
    ("std::panicking", "rust_std_panicking"),
];

const RUNNER_STACK_FRAME_CAP: usize = 8;

/// Lossy, fixed-vocabulary runtime-frame shape.
///
/// This is deliberately not a stack identity: distinct application stacks
/// whose recognised runtime frames match collide by design. Exact whole-token
/// equality here is a new, stricter discipline; `classify_runner_fatal_class`
/// is not precedent because it intentionally uses substring containment. The
/// only inherited safety property is that outputs are fixed tokens and never
/// copy input bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerStackShape {
    pub shape: String,
    pub depth: u8,
    pub redacted_frames: u8,
    pub signature: String,
}

fn strip_frame_location(candidate: &str) -> &str {
    let Some((before_column, column)) = candidate.rsplit_once(':') else {
        return candidate;
    };
    if column.is_empty() || !column.bytes().all(|byte| byte.is_ascii_digit()) {
        return candidate;
    }
    let Some((frame, line)) = before_column.rsplit_once(':') else {
        return candidate;
    };
    if line.is_empty() || !line.bytes().all(|byte| byte.is_ascii_digit()) {
        return candidate;
    }
    frame
}

fn runtime_frame_token(candidate: &str) -> Option<&'static str> {
    let candidate = strip_frame_location(candidate);
    RUNTIME_FRAME_TABLE
        .iter()
        .find(|(marker, _)| candidate.eq_ignore_ascii_case(marker))
        .map(|(_, token)| *token)
}

fn parenthesized_runtime_frame_token(line: &str) -> Option<&'static str> {
    let line = line.trim();
    if !line
        .get(..3)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("at "))
    {
        return None;
    }
    let open = line.rfind('(')?;
    let close = line.rfind(')')?;
    (open < close)
        .then(|| runtime_frame_token(line[open + 1..close].trim()))
        .flatten()
}

/// Normalize the dying process's ordered, bounded stderr tail without letting
/// any raw line, path, symbol, or line number escape.
pub fn runner_stack_shape(tail: &[String]) -> RunnerStackShape {
    let mut frames = Vec::with_capacity(tail.len().min(RUNNER_STACK_FRAME_CAP));
    let mut redacted_frames = 0_u8;
    let mut recognised = false;

    for line in tail.iter().take(RUNNER_STACK_FRAME_CAP) {
        let candidates = line
            .split(|character: char| {
                character.is_ascii_whitespace() || matches!(character, '(' | ')' | ',')
            })
            .filter(|candidate| !candidate.is_empty())
            .collect::<Vec<_>>();
        let mut tokens = candidates
            .iter()
            .enumerate()
            .filter_map(|(index, candidate)| {
                let is_frame_position = index == 0
                    || candidates[index - 1].eq_ignore_ascii_case("at")
                    || candidates[index - 1].eq_ignore_ascii_case("file")
                    || (index >= 2
                        && candidates[index - 2].eq_ignore_ascii_case("at")
                        && candidates[index - 1].eq_ignore_ascii_case("async"));
                is_frame_position
                    .then(|| runtime_frame_token(candidate))
                    .flatten()
            })
            .collect::<Vec<_>>();
        if tokens.is_empty() {
            if let Some(token) = parenthesized_runtime_frame_token(line) {
                tokens.push(token);
            }
        }
        if tokens.is_empty() {
            frames.push("app");
            redacted_frames = redacted_frames.saturating_add(1);
        } else {
            recognised = true;
            for token in tokens {
                if frames.len() == RUNNER_STACK_FRAME_CAP {
                    break;
                }
                frames.push(token);
            }
        }
        if frames.len() == RUNNER_STACK_FRAME_CAP {
            break;
        }
    }

    let depth = frames.len() as u8;
    if !recognised {
        return RunnerStackShape {
            shape: "all_redacted".to_string(),
            depth,
            redacted_frames: depth,
            signature: "unknown".to_string(),
        };
    }

    let shape = frames.join(">");
    let digest = format!("{:x}", Sha256::digest(shape.as_bytes()));
    RunnerStackShape {
        shape,
        depth,
        redacted_frames,
        signature: digest[..16].to_string(),
    }
}

/// Fixed, content-safe classes for runner error rollups. These values are safe
/// for Sentry tags because they are selected from code, never copied from a
/// runner message, path, argv, or file content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerErrorClass {
    Eperm,
    Eacces,
    Enospc,
    Ebusy,
    Network,
    Auth,
    Other,
}

impl RunnerErrorClass {
    fn tag_name(self) -> &'static str {
        match self {
            Self::Eperm => "EPERM",
            Self::Eacces => "EACCES",
            Self::Enospc => "ENOSPC",
            Self::Ebusy => "EBUSY",
            Self::Network => "NETWORK",
            Self::Auth => "AUTH",
            Self::Other => "OTHER",
        }
    }

    fn fingerprint_token(self) -> &'static str {
        match self {
            Self::Eperm => "eperm",
            Self::Eacces => "eacces",
            Self::Enospc => "enospc",
            Self::Ebusy => "ebusy",
            Self::Network => "network",
            Self::Auth => "auth",
            Self::Other => "other",
        }
    }
}

/// Map an untrusted runner error message to a fixed telemetry class. This
/// function deliberately returns no message text, so its output is safe to
/// attach to Sentry as a tag.
pub fn classify_runner_error_class(message: &str) -> RunnerErrorClass {
    let msg = message.to_lowercase();
    if msg.contains("eperm") {
        RunnerErrorClass::Eperm
    } else if msg.contains("eacces") {
        RunnerErrorClass::Eacces
    } else if msg.contains("enospc") {
        RunnerErrorClass::Enospc
    } else if msg.contains("ebusy") {
        RunnerErrorClass::Ebusy
    } else if is_transient_network_error(&msg) {
        RunnerErrorClass::Network
    } else if ["auth", "unauthorized", "forbidden", "cognito", "token"]
        .iter()
        .any(|marker| msg.contains(marker))
    {
        RunnerErrorClass::Auth
    } else {
        RunnerErrorClass::Other
    }
}

/// Fixed, content-safe Node filesystem operation tokens. Every value is
/// chosen from this declaration and never copied from runner output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerErrorOp {
    Rename,
    Unlink,
    Open,
    Mkdir,
    Rmdir,
    Symlink,
    Readlink,
    Stat,
    Lstat,
    Chmod,
    Copyfile,
    Utimes,
    Scandir,
    Read,
    Write,
    Access,
    Other,
}

impl RunnerErrorOp {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rename => "rename",
            Self::Unlink => "unlink",
            Self::Open => "open",
            Self::Mkdir => "mkdir",
            Self::Rmdir => "rmdir",
            Self::Symlink => "symlink",
            Self::Readlink => "readlink",
            Self::Stat => "stat",
            Self::Lstat => "lstat",
            Self::Chmod => "chmod",
            Self::Copyfile => "copyfile",
            Self::Utimes => "utimes",
            Self::Scandir => "scandir",
            Self::Read => "read",
            Self::Write => "write",
            Self::Access => "access",
            Self::Other => "other",
        }
    }
}

/// Classify the operation portion of a Node errno message such as
/// "EPERM: operation not permitted, rename <path>". The message is inspected
/// only to choose a closed-vocabulary value and is never retained here.
pub fn classify_runner_error_op(message: &str) -> RunnerErrorOp {
    let normalized = message.to_ascii_lowercase();
    for segment in normalized.split(',').skip(1) {
        let operation = segment
            .trim_start()
            .split(|character: char| character.is_whitespace() || character == ':')
            .next()
            .unwrap_or_default();
        let class = match operation {
            "rename" => RunnerErrorOp::Rename,
            "unlink" => RunnerErrorOp::Unlink,
            "open" => RunnerErrorOp::Open,
            "mkdir" => RunnerErrorOp::Mkdir,
            "rmdir" => RunnerErrorOp::Rmdir,
            "symlink" => RunnerErrorOp::Symlink,
            "readlink" => RunnerErrorOp::Readlink,
            "stat" => RunnerErrorOp::Stat,
            "lstat" => RunnerErrorOp::Lstat,
            "chmod" => RunnerErrorOp::Chmod,
            "copyfile" => RunnerErrorOp::Copyfile,
            "utimes" => RunnerErrorOp::Utimes,
            "scandir" => RunnerErrorOp::Scandir,
            "read" => RunnerErrorOp::Read,
            "write" => RunnerErrorOp::Write,
            "access" => RunnerErrorOp::Access,
            _ => continue,
        };
        return class;
    }
    RunnerErrorOp::Other
}

/// Stable, content-safe cause tokens for a runner that terminates before it
/// can emit a normal protocol result. They are intentionally more specific
/// than [`is_fatal_runner_signature`], but reporting-only: no caller may use
/// them to alter capture, suppression, restart, or fingerprint behavior.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RunnerFatalClass {
    LibuvAssert,
    NodeFatal,
    HeapOom,
    RustPanic,
    ExecPermissionDenied,
    ExecNotFound,
    NodeTooOld,
    #[default]
    None,
}

impl RunnerFatalClass {
    /// Fixed vocabulary safe for Sentry tags and breadcrumbs.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LibuvAssert => "libuv_assert",
            Self::NodeFatal => "node_fatal",
            Self::HeapOom => "heap_oom",
            Self::RustPanic => "rust_panic",
            Self::ExecPermissionDenied => "exec_permission_denied",
            Self::ExecNotFound => "exec_not_found",
            Self::NodeTooOld => "node_too_old",
            Self::None => "none",
        }
    }

    pub fn seen(self) -> bool {
        self != Self::None
    }
}

/// Classify untrusted runner stderr without retaining any of it. The libuv
/// match deliberately requires both an assertion marker and a libuv-specific
/// source/handle marker so ordinary application assertions remain `none`.
pub fn classify_runner_fatal_class(line: &str) -> RunnerFatalClass {
    let msg = line.to_ascii_lowercase();
    if is_node_too_old_signature(&msg) {
        RunnerFatalClass::NodeTooOld
    } else if msg.contains("assertion failed")
        && (msg.contains("libuv")
            || msg.contains("uv_handle")
            || msg.contains("src\\win\\async.c")
            || msg.contains("src/win/async.c"))
    {
        RunnerFatalClass::LibuvAssert
    } else if msg.contains("javascript heap out of memory") {
        RunnerFatalClass::HeapOom
    } else if msg.contains("panicked at") {
        RunnerFatalClass::RustPanic
    } else if ["fatal error", "uncaught exception", "unhandledrejection"]
        .iter()
        .any(|marker| msg.contains(marker))
    {
        RunnerFatalClass::NodeFatal
    } else if is_runner_exec_shell_failure(&msg, "permission denied") {
        RunnerFatalClass::ExecPermissionDenied
    } else if is_runner_exec_shell_failure(&msg, "no such file or directory")
        || is_runner_exec_shell_failure(&msg, "command not found")
    {
        RunnerFatalClass::ExecNotFound
    } else {
        RunnerFatalClass::None
    }
}

/// Shell launch diagnostics have a small, stable shape. Requiring that shape
/// keeps ordinary runner file errors (which also contain EACCES or ENOENT) out
/// of the executable-launch classes. The source line remains local; this only
/// decides which fixed token, if any, may be reported.
fn is_runner_exec_shell_failure(message: &str, marker: &str) -> bool {
    let shell_prefix = ["sh: ", "bash: ", "zsh: ", "fish: "]
        .iter()
        .any(|prefix| message.starts_with(prefix));
    let npx_runner_target = message.contains("/.npm/_npx/")
        || message.contains("node_modules/.bin/hq-sync-runner")
        || message.contains("hq-sync-runner:");
    message.contains(marker) && (shell_prefix || npx_runner_target)
}

/// Saturating per-pass counts that render as a compact, fixed-vocabulary Sentry
/// tag such as `EPERM:412,OTHER:1`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunnerErrorRollup {
    eperm: u32,
    eacces: u32,
    enospc: u32,
    ebusy: u32,
    network: u32,
    auth: u32,
    other: u32,
}

impl RunnerErrorRollup {
    fn record(&mut self, message: &str) {
        let count = match classify_runner_error_class(message) {
            RunnerErrorClass::Eperm => &mut self.eperm,
            RunnerErrorClass::Eacces => &mut self.eacces,
            RunnerErrorClass::Enospc => &mut self.enospc,
            RunnerErrorClass::Ebusy => &mut self.ebusy,
            RunnerErrorClass::Network => &mut self.network,
            RunnerErrorClass::Auth => &mut self.auth,
            RunnerErrorClass::Other => &mut self.other,
        };
        *count = count.saturating_add(1);
    }

    /// Render only fixed class names and decimal counts. `None` means this
    /// watcher pass saw no runner error records, so no tag should be sent.
    pub fn tag_value(&self) -> Option<String> {
        let counts = [
            (RunnerErrorClass::Eperm, self.eperm),
            (RunnerErrorClass::Eacces, self.eacces),
            (RunnerErrorClass::Enospc, self.enospc),
            (RunnerErrorClass::Ebusy, self.ebusy),
            (RunnerErrorClass::Network, self.network),
            (RunnerErrorClass::Auth, self.auth),
            (RunnerErrorClass::Other, self.other),
        ];
        let rendered: Vec<_> = counts
            .into_iter()
            .filter(|(_, count)| *count > 0)
            .map(|(class, count)| format!("{}:{count}", class.tag_name()))
            .collect();
        (!rendered.is_empty()).then(|| rendered.join(","))
    }

    /// Choose a stable, content-safe group token for a runner termination.
    /// Higher counts win; equal counts deliberately preserve the fixed enum
    /// declaration order so the same multiset cannot make grouping flap.
    pub fn fingerprint_token(&self) -> &'static str {
        let counts = [
            (RunnerErrorClass::Eperm, self.eperm),
            (RunnerErrorClass::Eacces, self.eacces),
            (RunnerErrorClass::Enospc, self.enospc),
            (RunnerErrorClass::Ebusy, self.ebusy),
            (RunnerErrorClass::Network, self.network),
            (RunnerErrorClass::Auth, self.auth),
            (RunnerErrorClass::Other, self.other),
        ];
        let mut dominant = None;
        let mut dominant_count = 0;
        for (class, count) in counts {
            if count > dominant_count {
                dominant = Some(class);
                dominant_count = count;
            }
        }
        dominant
            .map(RunnerErrorClass::fingerprint_token)
            .unwrap_or("none")
    }
}

/// Saturating per-pass counts of the closed Node operation vocabulary.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunnerErrorOpRollup {
    rename: u32,
    unlink: u32,
    open: u32,
    mkdir: u32,
    rmdir: u32,
    symlink: u32,
    readlink: u32,
    stat: u32,
    lstat: u32,
    chmod: u32,
    copyfile: u32,
    utimes: u32,
    scandir: u32,
    read: u32,
    write: u32,
    access: u32,
    other: u32,
}

impl RunnerErrorOpRollup {
    fn record(&mut self, message: &str) {
        let count = match classify_runner_error_op(message) {
            RunnerErrorOp::Rename => &mut self.rename,
            RunnerErrorOp::Unlink => &mut self.unlink,
            RunnerErrorOp::Open => &mut self.open,
            RunnerErrorOp::Mkdir => &mut self.mkdir,
            RunnerErrorOp::Rmdir => &mut self.rmdir,
            RunnerErrorOp::Symlink => &mut self.symlink,
            RunnerErrorOp::Readlink => &mut self.readlink,
            RunnerErrorOp::Stat => &mut self.stat,
            RunnerErrorOp::Lstat => &mut self.lstat,
            RunnerErrorOp::Chmod => &mut self.chmod,
            RunnerErrorOp::Copyfile => &mut self.copyfile,
            RunnerErrorOp::Utimes => &mut self.utimes,
            RunnerErrorOp::Scandir => &mut self.scandir,
            RunnerErrorOp::Read => &mut self.read,
            RunnerErrorOp::Write => &mut self.write,
            RunnerErrorOp::Access => &mut self.access,
            RunnerErrorOp::Other => &mut self.other,
        };
        *count = count.saturating_add(1);
    }

    /// Render only fixed operation names and decimal counts for a Sentry tag.
    pub fn tag_value(&self) -> Option<String> {
        let counts = [
            (RunnerErrorOp::Rename, self.rename),
            (RunnerErrorOp::Unlink, self.unlink),
            (RunnerErrorOp::Open, self.open),
            (RunnerErrorOp::Mkdir, self.mkdir),
            (RunnerErrorOp::Rmdir, self.rmdir),
            (RunnerErrorOp::Symlink, self.symlink),
            (RunnerErrorOp::Readlink, self.readlink),
            (RunnerErrorOp::Stat, self.stat),
            (RunnerErrorOp::Lstat, self.lstat),
            (RunnerErrorOp::Chmod, self.chmod),
            (RunnerErrorOp::Copyfile, self.copyfile),
            (RunnerErrorOp::Utimes, self.utimes),
            (RunnerErrorOp::Scandir, self.scandir),
            (RunnerErrorOp::Read, self.read),
            (RunnerErrorOp::Write, self.write),
            (RunnerErrorOp::Access, self.access),
            (RunnerErrorOp::Other, self.other),
        ];
        let rendered: Vec<_> = counts
            .into_iter()
            .filter(|(_, count)| *count > 0)
            .map(|(operation, count)| format!("{}:{count}", operation.as_str()))
            .collect();
        (!rendered.is_empty()).then(|| rendered.join(","))
    }
}

/// A successful runner exit normally needs a synthetic AllComplete when the
/// protocol ended early. Auth-required is the exception: its dedicated state
/// must remain visible so manual sync and watch/daemon paths agree.
pub fn should_synthesize_all_complete(
    success: bool,
    all_complete_seen: bool,
    saw_auth_error: bool,
) -> bool {
    success && !all_complete_seen && !saw_auth_error
}

/// Exit code the runner returns when another operation already holds this HQ
/// root's lock (hq-cloud `OPERATION_LOCKED_EXIT`, a stable non-zero code). A
/// concurrent sync is a normal race — e.g. instant-sync firing while a manual
/// or scheduled sync is already mid-run — not a failure, so the menubar must
/// never escalate it to a Sentry alert. See `should_alert_on_nonzero_exit`.
pub const RUNNER_OPERATION_LOCKED_EXIT: i32 = 17;

/// Exit code returned by hq-cloud's `TRANSIENT_NETWORK_EXIT` / `EX_TEMPFAIL`
/// retry contract. hq-cloud uses it at the auth-refresh return site, both
/// discovery return sites, and the fanout tail; the desktop must end the
/// current UI run without escalating a self-healing retry to Sentry.
pub const RUNNER_TRANSIENT_RETRY_EXIT: i32 = 75;

/// POSIX SIGTERM. When the runner exits killed by this signal it was OUR
/// cancellation: `cancel_process_impl` sends SIGTERM (escalating to SIGKILL
/// only if the runner ignores it) on every expected cancel — the Stop button,
/// the 1-hour timeout watchdog, app quit, or a newer sync superseding this one.
/// An expected cancellation must never escalate to a Sentry alert (HQ-SYNC-WEB-H:
/// 23 "killed by SIGTERM (cancelled)" events). See `should_alert_on_nonzero_exit`.
pub const SIGTERM_SIGNAL: i32 = 15;

/// Windows `STATUS_CONTROL_C_EXIT` (`0xC000013A`) represented as the signed
/// process exit code Rust reports. Windows gives this status to a console
/// process when its default console-control handler ends it, including a
/// Ctrl+C/Ctrl+Break, console close, logoff, or shutdown. It is the Windows
/// counterpart to the POSIX SIGTERM teardown carve-out, not a general NTSTATUS
/// classifier: real Windows fault statuses must remain alertable.
pub const WINDOWS_CONTROL_C_EXIT: i32 = -1073741510;

/// Windows `DBG_TERMINATE_PROCESS` (`0x40010004`). This is a control/status
/// result, not a conventional runner `exit(N)`, so keeping it in the Windows
/// namespace prevents another per-decimal Sentry issue.
pub const WINDOWS_SESSION_TERMINATE_EXIT: i32 = 0x4001_0004;

/// The raw Windows status `0xFFFFFFFF` represented as Rust's signed process
/// exit code. A process can produce this value itself, and `TerminateProcess`
/// lets its caller choose the exit code, so the status does not establish who
/// or what ended the process. It is intentionally *not* benign: the watcher
/// capture must carry lifecycle and runner diagnostics before triage can infer
/// a cause.
pub const WINDOWS_STATUS_FFFFFFFF: i32 = -1;

/// A content-safe classification of a raw Windows process status. This remains
/// pure and deliberately has no `target_os` gate: test jobs on every platform
/// must pin the Windows wire values even though only Windows emits them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsTermination {
    ConsoleControl,
    SessionTerminate,
    IndeterminateStatus,
    Fault(u32),
    Ordinary(i32),
}

impl WindowsTermination {
    /// Stable, fixed-vocabulary name safe for a Sentry tag.
    pub fn class_name(self) -> &'static str {
        match self {
            Self::ConsoleControl => "console_control",
            Self::SessionTerminate => "session_terminate",
            Self::IndeterminateStatus => "indeterminate_status",
            Self::Fault(_) => "fault",
            Self::Ordinary(_) => "ordinary",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::ConsoleControl => "console control",
            Self::SessionTerminate => "session terminate",
            Self::IndeterminateStatus => "origin unknown",
            Self::Fault(_) => "fault",
            Self::Ordinary(_) => "ordinary exit",
        }
    }

    /// True only for an exit shape that is recognizably a Windows status. A
    /// small conventional code (1, 2, 17, …) is portable and must retain its
    /// existing POSIX-shaped fingerprint.
    pub fn is_windows_status(self) -> bool {
        !matches!(self, Self::Ordinary(_))
    }
}

/// Classify a raw signed exit code by its Windows bit pattern. The order is
/// intentional: `0xFFFFFFFF` has the high fault bits set, but it carries no
/// termination provenance and must retain its own neutral diagnostic class.
pub fn classify_windows_exit_status(code: i32) -> WindowsTermination {
    let raw = code as u32;
    if code == WINDOWS_CONTROL_C_EXIT {
        WindowsTermination::ConsoleControl
    } else if code == WINDOWS_SESSION_TERMINATE_EXIT {
        WindowsTermination::SessionTerminate
    } else if code == WINDOWS_STATUS_FFFFFFFF {
        WindowsTermination::IndeterminateStatus
    } else if raw & 0xC000_0000 == 0xC000_0000 {
        WindowsTermination::Fault(raw)
    } else {
        WindowsTermination::Ordinary(code)
    }
}

/// Canonical uppercase eight-digit status rendering for a Windows raw exit.
/// It preserves the unsigned bit pattern instead of leaking Rust's signed
/// representation (for example `-1` becomes `0xFFFFFFFF`).
pub fn windows_exit_status_hex(code: i32) -> String {
    format!("0x{:08X}", code as u32)
}

/// Name the small, well-known set of Windows status values observed or likely
/// for sync-runner crashes. This is separate from WindowsTermination so adding
/// a label cannot change its established grouping or capture semantics.
pub fn windows_fault_symbol(code: i32) -> Option<&'static str> {
    match code as u32 {
        0xC000_0409 => Some("STATUS_STACK_BUFFER_OVERRUN"),
        0xC000_0005 => Some("ACCESS_VIOLATION"),
        0xC000_013A => Some("CONTROL_C_EXIT"),
        0x8000_0003 => Some("BREAKPOINT"),
        _ => None,
    }
}

/// Returns whether a process ended with the exact Windows console-control
/// teardown status. Requiring an ordinary exit code and no Unix signal keeps
/// malformed dual-status events and every other Windows fault code loud.
pub fn is_windows_console_control_exit(code: Option<i32>, signal: Option<i32>) -> bool {
    code == Some(WINDOWS_CONTROL_C_EXIT) && signal.is_none()
}

/// Stable, structured Sentry fingerprint component for a runner termination.
///
/// Process exit statuses and Unix signals occupy different namespaces: an
/// `exit(2)` means the runner deliberately returned its documented error code,
/// while `SIGINT` is signal 2 and means the OS interrupted it. Keep that
/// distinction in the value itself so Sentry can never group the two histories
/// together. The malformed both-present state is also isolated rather than
/// silently preferring one field and merging it with a valid termination.
pub fn termination_fingerprint_token(code: Option<i32>, signal: Option<i32>) -> String {
    match (code, signal) {
        (Some(code), None) => match classify_windows_exit_status(code) {
            WindowsTermination::ConsoleControl => "windows:console-control".to_string(),
            WindowsTermination::SessionTerminate => "windows:session-terminate".to_string(),
            WindowsTermination::IndeterminateStatus => "windows:status-ffffffff".to_string(),
            WindowsTermination::Fault(raw) => format!("windows:fault:0x{raw:08X}"),
            WindowsTermination::Ordinary(code) => format!("exit:{code}"),
        },
        (None, Some(signal)) => format!("signal:{signal}"),
        (Some(code), Some(signal)) => format!("invalid:exit:{code}+signal:{signal}"),
        (None, None) => "unknown".to_string(),
    }
}

/// Render a process termination as a human-readable string. When `code` is
/// `Some(N)`, the process called `exit(N)`. When `signal` is `Some(N)`, the
/// OS killed it with that signal — name it (SIGKILL=9, SIGTERM=15, SIGSEGV=11,
/// SIGBUS=10, SIGABRT=6) so "code unknown" no longer hides whether the runner
/// was OOM-killed vs crashed vs cancelled.
pub fn describe_exit(code: Option<i32>, signal: Option<i32>) -> String {
    if let Some(c) = code {
        let termination = classify_windows_exit_status(c);
        if termination.is_windows_status() {
            return format!(
                "with Windows status {} ({})",
                windows_exit_status_hex(c),
                termination.description()
            );
        }
        return format!("with code {}", c);
    }
    match signal {
        Some(9) => "killed by SIGKILL (likely OOM or force-quit)".into(),
        Some(15) => "killed by SIGTERM (cancelled)".into(),
        Some(11) => "crashed with SIGSEGV (segfault)".into(),
        Some(10) => "crashed with SIGBUS".into(),
        Some(6) => "aborted with SIGABRT".into(),
        Some(2) => "killed by SIGINT".into(),
        Some(1) => "killed by SIGHUP".into(),
        Some(n) => format!("killed by signal {}", n),
        None => "with code unknown".into(),
    }
}

/// Explicit Sentry policy for an auto-sync watcher termination.
///
/// `Capture` retains the normal crash-loop milestone limiter at the caller.
/// `CaptureRateLimited` is reserved for failures that are initially
/// environmental but need an escalating, milestone-limited alert if they
/// persist. `LocalLogOnly` records a breadcrumb without creating an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherExitCapturePolicy {
    Capture,
    CaptureRateLimited,
    LocalLogOnly,
}

/// Explicit Sentry policy for a failure returned by `Command::spawn`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnFailureCapturePolicy {
    CaptureRateLimited,
    RetryAndLog,
}

/// OS errno namespace used when Rust leaves a resource-exhaustion error as
/// `ErrorKind::Other`. Keep it explicit: errno 11 means EAGAIN on Linux but a
/// different Windows error, so raw values must never be treated as portable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SpawnFailurePlatform {
    Linux,
    Macos,
    Other,
}

/// First crash-loop milestone at which a persistent exec-not-runnable watcher
/// becomes worth an alert. A one-off 126/127 is the same environmental class as
/// the runner-resolution preflight; repeated failures still need visibility.
pub const EXEC_NOT_RUNNABLE_CAPTURE_AFTER_CONSECUTIVE: u32 = 4;

/// Classify the watcher exit itself. The caller owns lifecycle state and the
/// existing crash-loop counter, so this pure policy deliberately does not
/// mutate either one.
pub fn watcher_exit_capture_policy(
    code: Option<i32>,
    signal: Option<i32>,
) -> WatcherExitCapturePolicy {
    if signal.is_some() {
        return WatcherExitCapturePolicy::Capture;
    }

    match code {
        // Runner protocol/environment outcomes already handled locally.
        Some(1 | 2) => WatcherExitCapturePolicy::LocalLogOnly,
        // Shell/exec layer: the runner command was not runnable after the
        // startup preflight. Do not page for a blip, but escalate a streak.
        Some(126 | 127) => WatcherExitCapturePolicy::CaptureRateLimited,
        // Unknown codes (including the observed 221) remain alertable until
        // their producer is identified; never guess a benign classification.
        _ => WatcherExitCapturePolicy::Capture,
    }
}

/// Preserve the existing power-of-two crash-loop dampening while making the
/// exec-not-runnable escalation explicit and table-testable.
pub fn should_capture_watcher_exit(policy: WatcherExitCapturePolicy, consecutive: u32) -> bool {
    match policy {
        WatcherExitCapturePolicy::LocalLogOnly => false,
        WatcherExitCapturePolicy::Capture => is_capture_milestone(consecutive),
        WatcherExitCapturePolicy::CaptureRateLimited => {
            consecutive >= EXEC_NOT_RUNNABLE_CAPTURE_AFTER_CONSECUTIVE
                && is_capture_milestone(consecutive)
        }
    }
}

/// Capture the first failure and powers of two thereafter. Kept shared with
/// the daemon so policy tests can protect the production crash-loop contract.
pub fn is_capture_milestone(consecutive: u32) -> bool {
    consecutive <= 1 || consecutive.is_power_of_two()
}

/// Classify a native spawn failure without looking at a formatted message or a
/// machine-specific command path. EAGAIN/EWOULDBLOCK, ENOMEM, EMFILE and ENFILE
/// are transient resource exhaustion; the daemon's normal respawn recovers
/// them, so they only log locally.
pub fn spawn_failure_capture_policy(
    kind: ErrorKind,
    raw_os_error: Option<i32>,
) -> SpawnFailureCapturePolicy {
    spawn_failure_capture_policy_for_platform(kind, raw_os_error, current_spawn_failure_platform())
}

fn spawn_failure_capture_policy_for_platform(
    kind: ErrorKind,
    raw_os_error: Option<i32>,
    platform: SpawnFailurePlatform,
) -> SpawnFailureCapturePolicy {
    let resource_errno = match platform {
        SpawnFailurePlatform::Linux => matches!(raw_os_error, Some(11 | 12 | 23 | 24)),
        SpawnFailurePlatform::Macos => matches!(raw_os_error, Some(12 | 23 | 24 | 35)),
        SpawnFailurePlatform::Other => false,
    };
    if matches!(kind, ErrorKind::WouldBlock | ErrorKind::OutOfMemory) || resource_errno {
        SpawnFailureCapturePolicy::RetryAndLog
    } else {
        SpawnFailureCapturePolicy::CaptureRateLimited
    }
}

fn current_spawn_failure_platform() -> SpawnFailurePlatform {
    if cfg!(target_os = "linux") {
        SpawnFailurePlatform::Linux
    } else if cfg!(target_os = "macos") {
        SpawnFailurePlatform::Macos
    } else {
        SpawnFailurePlatform::Other
    }
}

/// Stable, path-free Sentry grouping component for a spawn failure.
///
/// ErrorKind is intentionally the entire identity for non-resource errors:
/// it groups equivalent OS failures across `/usr/local/bin/npx`, Homebrew, and
/// managed-runtime paths without leaking a user or machine path into Sentry.
pub fn spawn_failure_fingerprint_token(kind: ErrorKind, raw_os_error: Option<i32>) -> &'static str {
    match spawn_failure_capture_policy(kind, raw_os_error) {
        SpawnFailureCapturePolicy::RetryAndLog => "resource-exhausted",
        SpawnFailureCapturePolicy::CaptureRateLimited => match kind {
            ErrorKind::NotFound => "not-found",
            ErrorKind::PermissionDenied => "permission-denied",
            ErrorKind::TimedOut => "timed-out",
            ErrorKind::Interrupted => "interrupted",
            ErrorKind::InvalidInput => "invalid-input",
            ErrorKind::Unsupported => "unsupported",
            _ => "other-io-error",
        },
    }
}

/// Returns `true` when a per-company error indicates the company has not been
/// provisioned on S3 yet.
///
/// Only per-company sentinel errors (`path == "(company)"`) are eligible; file-
/// level errors on real paths are never entity-not-found and must surface normally.
///
/// Match logic is deliberately narrow to avoid swallowing auth / STS errors
/// whose HTTP bodies can also contain generic "not found" substrings:
/// - `"no bucket provisioned"` is an exact phrase unique to the vault guard.
/// - For HTTP-404 paths we require **both** `"entity"` and `"not found"` so
///   that `"Token not found"`, `"Session not found"`, etc. are excluded.
pub fn is_entity_not_yet_provisioned(err: &SyncErrorEvent) -> bool {
    if err.path != "(company)" {
        return false;
    }
    let msg = err.message.to_lowercase();
    msg.contains("no bucket provisioned") || (msg.contains("entity") && msg.contains("not found"))
}

/// Returns `true` when a runner error message is a transient, retryable network
/// condition that the next sync cycle recovers from on its own — a socket reset
/// mid-fanout, a momentary DNS hiccup, a connection timeout. These are not
/// actionable: sync runs every cycle, one machine's momentary connectivity blip
/// self-heals, and persistent vault/S3 outages surface in server-side
/// monitoring rather than per-client crash reports. The runner's `describeError`
/// walks the AWS-SDK cause chain so the underlying Node networking code
/// (`ECONNRESET`, `ETIMEDOUT`, …) reaches us instead of a bare "UnknownError".
///
/// Deliberately matches only unambiguous network-layer markers — HTTP-status
/// errors (`403`, `404`, `5xx`) and filesystem errors (`EISDIR`) are NOT
/// transient and must keep alerting.
pub fn is_transient_network_error(message: &str) -> bool {
    let msg = message.to_lowercase();
    const TRANSIENT_MARKERS: &[&str] = &[
        "econnreset",
        "econnrefused",
        "etimedout",
        "epipe",
        "eai_again",
        "enetdown",
        "enetunreach",
        "ehostunreach",
        "socket hang up",
        "timeouterror",
    ];
    TRANSIENT_MARKERS.iter().any(|m| msg.contains(m))
}

/// Returns `true` when an expected, client-handled per-file ACL-scope skip —
/// the server correctly returned `403 SCOPE_EXCEEDS_PARENT` for a path outside
/// the caller's granted scope, so the runner SKIPPED the file (it stays
/// local-only) and emitted a per-file `error` event telling the user to grant
/// the path. The rest of the sync succeeds, but the runner still exits non-zero
/// (2) because the skip counts toward its `errors` tally (`hq-cloud`
/// `executeCompanyFanout`). This is not an actionable defect — alerting on it
/// flooded Sentry (HQ-SYNC-WEB-6) with zero-user-impact noise.
///
/// Matches the two stable markers `hq-cloud`'s `src/cli/share.ts` emits on both
/// the HEAD and PUT skip paths; deliberately narrow so a real 403 elsewhere
/// (auth / cross-tenant probe) is not swallowed.
pub fn is_expected_acl_scope_skip(message: &str) -> bool {
    let msg = message.to_lowercase();
    msg.contains("outside granted acl scope") || msg.contains("scope_exceeds_parent")
}

/// True when raw runner stderr is the Node-too-old startup crash:
/// `diagnostics_channel.tracingChannel` is unavailable before Node 20, or npm
/// reports an `EBADENGINE` warning for the `node` engine. Narrow matching keeps
/// unrelated stderr from suppressing real defects.
pub fn is_node_too_old_signature(line: &str) -> bool {
    let msg = line.to_lowercase();
    msg.contains("tracingchannel is not a function")
        || (msg.contains("ebadengine") && msg.contains("node"))
}

/// Conservative raw-stderr markers that indicate the runner itself failed
/// before it could provide a normal protocol result. This is evidence only;
/// it never changes the capture/suppression decision.
pub fn is_fatal_runner_signature(line: &str) -> bool {
    let msg = line.to_lowercase();
    is_node_too_old_signature(&msg)
        || [
            "fatal error",
            "uncaught exception",
            "unhandledrejection",
            "panicked at",
        ]
        .iter()
        .any(|marker| msg.contains(marker))
}

/// Returns `true` when a runner error should raise a Sentry alert if it drives a
/// non-zero runner exit. Applies to errors of ANY level — company-level
/// (`path == "(company)"`) and per-file alike — because `hq-cloud`'s fanout
/// counts both toward the exit-2 tally.
///
/// Benign (no alert):
///   - not-yet-provisioned companies — the vault's *correct* 404 / "no bucket
///     provisioned" (company-level only). `handle_sync_line` already
///     reclassifies these into an empty-sync `Complete` for the UI via
///     `classify_error_event`; alerting at exit would re-raise the very
///     condition the UI just absorbed.
///   - transient, retryable network errors (`is_transient_network_error`).
///   - expected per-file ACL-scope skips (`is_expected_acl_scope_skip`): a
///     `403 SCOPE_EXCEEDS_PARENT` the user resolves by granting the path, not a
///     server fault — the dominant HQ-SYNC-WEB-6 noise source.
///
/// Everything else (EISDIR, other 403/404 auth, 5xx-after-retries,
/// `UnknownError`, anything unrecognised) is treated as a real defect and keeps
/// alerting — fail safe toward surfacing, not swallowing.
pub fn is_alertable_error(err: &SyncErrorEvent) -> bool {
    !(is_entity_not_yet_provisioned(err)
        || is_transient_network_error(&err.message)
        || is_expected_acl_scope_skip(&err.message))
}

/// Pure policy: how should a *non-zero* runner exit finish?
///
/// Extracted from the `ProcessEvent::Exit` handler so the decision is
/// unit-testable without a live `AppHandle`. It preserves the existing
/// alert-versus-suppression semantics while distinguishing terminal UI effects:
///
///   - exit 17 (`OPERATION_LOCKED`): another sync holds the lock — a normal
///     concurrent-sync race, never a failure.
///   - a run whose errors were all benign (`saw_error && !saw_alertable_error`):
///     the non-zero exit is fully explained by not-yet-provisioned 404s,
///     transient network blips, and/or expected per-file ACL-scope skips.
///   - a Node-too-old startup crash (`saw_node_too_old`): the runner could not
///     start under the user's Node version, so this is an environment fault
///     surfaced to the UI rather than an alertable product defect.
///   - exit 75 (`TRANSIENT_NETWORK_EXIT` / `EX_TEMPFAIL`): the runner reports
///     a retryable network outcome, so the current UI run must end without a
///     capture.
///
/// An *unexplained* non-zero exit — no error event seen at all, e.g. the runner
/// panicked or was OOM-killed before emitting protocol — still alerts,
/// preserving the original "bailed before emitting a useful stream" signal.
///
/// A SIGTERM kill is never a defect: it is our own `cancel_process_impl` ending
/// the run (Stop / timeout / quit / supersede). The exact Windows
/// `STATUS_CONTROL_C_EXIT` is likewise an OS console-control teardown. Both
/// are suppressed regardless of any in-flight company errors. Other signals
/// and Windows fault statuses stay loud — SIGSEGV/SIGBUS/SIGABRT are crashes,
/// SIGKILL is OOM or a force-quit worth seeing, and only the one documented
/// Windows status is expected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerExitDisposition {
    /// Capture the termination and emit the existing runner-error event.
    Alert,
    /// Surface the actionable Node upgrade message without a capture.
    NodeTooOld,
    /// End the UI run after Windows console teardown without a capture.
    WindowsConsoleControl,
    /// End the UI run after hq-cloud's retryable network outcome without a capture.
    TransientRetry,
    /// Log a fully explained non-zero exit without an additional UI event.
    Ignore,
}

/// Classify the effects a non-zero runner exit should produce.
///
/// This is the sole exit-policy seam: callers that need a boolean must project
/// from it rather than repeating code, signal, or run-total conditions. Node
/// remediation intentionally outranks console-control and generic suppression,
/// preserving the manual-sync dispatch ordering that existed before this
/// classifier was introduced.
pub fn classify_runner_exit_disposition(
    code: Option<i32>,
    signal: Option<i32>,
    saw_error: bool,
    saw_alertable_error: bool,
    saw_node_too_old: bool,
) -> RunnerExitDisposition {
    if saw_node_too_old {
        return RunnerExitDisposition::NodeTooOld;
    }
    if is_windows_console_control_exit(code, signal) {
        return RunnerExitDisposition::WindowsConsoleControl;
    }
    if code == Some(RUNNER_TRANSIENT_RETRY_EXIT) {
        return RunnerExitDisposition::TransientRetry;
    }
    if signal == Some(SIGTERM_SIGNAL)
        || code == Some(RUNNER_OPERATION_LOCKED_EXIT)
        || (saw_error && !saw_alertable_error)
    {
        return RunnerExitDisposition::Ignore;
    }
    RunnerExitDisposition::Alert
}

/// Boolean compatibility projection for existing capture seams.
pub fn should_alert_on_nonzero_exit(
    code: Option<i32>,
    signal: Option<i32>,
    saw_error: bool,
    saw_alertable_error: bool,
    saw_node_too_old: bool,
) -> bool {
    matches!(
        classify_runner_exit_disposition(
            code,
            signal,
            saw_error,
            saw_alertable_error,
            saw_node_too_old,
        ),
        RunnerExitDisposition::Alert
    )
}

/// Classifies a per-company error event. Returns `Some(SyncCompleteEvent)` when
/// the error represents a company not yet provisioned on S3 (empty-sync
/// semantics), or `None` when the error should surface normally.
///
/// The `None`-company case (discovery-phase errors) always returns `None` so
/// those errors are never silently swallowed.
///
/// TODO: The durable fix belongs in `hq-cloud/src/context.ts` (`resolveEntityContext`)
/// so all consumers of hq-sync-runner get the correct behaviour without
/// pattern-matching on error strings across a process boundary.
pub fn classify_error_event(payload: &SyncErrorEvent) -> Option<SyncCompleteEvent> {
    let company = payload.company.as_deref()?;
    if !is_entity_not_yet_provisioned(payload) {
        return None;
    }
    Some(SyncCompleteEvent {
        company: company.to_string(),
        files_downloaded: 0,
        bytes_downloaded: 0,
        files_skipped: 0,
        conflicts: 0,
        aborted: false,
        // Synthetic complete for a not-yet-provisioned company: nothing was
        // ever on remote, nothing was journaled, so tombstone + refused-
        // stale counts are zero by construction. Use None (Option<u32>)
        // rather than Some(0) so the wire shape matches what a pre-5.24
        // runner would emit — keeps the renderer's "is this field
        // populated?" branch the cleaner one.
        files_tombstoned: None,
        files_refused_stale: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── describe_exit ────────────────────────────────────────────────────────────

    #[test]
    fn describe_exit_with_normal_exit_code() {
        assert_eq!(describe_exit(Some(0), None), "with code 0");
        assert_eq!(describe_exit(Some(1), None), "with code 1");
        assert_eq!(describe_exit(Some(127), None), "with code 127");
    }

    #[test]
    fn describe_exit_names_well_known_signals() {
        assert!(describe_exit(None, Some(9)).contains("SIGKILL"));
        assert!(describe_exit(None, Some(15)).contains("SIGTERM"));
        assert!(describe_exit(None, Some(11)).contains("SIGSEGV"));
        assert!(describe_exit(None, Some(10)).contains("SIGBUS"));
        assert!(describe_exit(None, Some(6)).contains("SIGABRT"));
        assert!(describe_exit(None, Some(2)).contains("SIGINT"));
        assert!(describe_exit(None, Some(1)).contains("SIGHUP"));
    }

    #[test]
    fn describe_exit_falls_back_to_signal_number() {
        assert_eq!(describe_exit(None, Some(31)), "killed by signal 31");
    }

    #[test]
    fn describe_exit_with_neither_returns_unknown() {
        assert_eq!(describe_exit(None, None), "with code unknown");
    }

    #[test]
    fn describe_exit_prefers_code_over_signal() {
        // Should never happen in practice (POSIX is XOR), but be defensive.
        assert_eq!(describe_exit(Some(42), Some(9)), "with code 42");
    }

    #[test]
    fn windows_exit_statuses_are_classified_from_independent_hex_literals() {
        assert_eq!(
            classify_windows_exit_status(0xC000_013Au32 as i32),
            WindowsTermination::ConsoleControl
        );
        assert_eq!(
            classify_windows_exit_status(0x4001_0004u32 as i32),
            WindowsTermination::SessionTerminate
        );
        assert_eq!(
            classify_windows_exit_status(0xFFFF_FFFFu32 as i32),
            WindowsTermination::IndeterminateStatus
        );
        for raw in [0xC000_0005u32, 0xC000_00FD, 0xC000_0409] {
            assert_eq!(
                classify_windows_exit_status(raw as i32),
                WindowsTermination::Fault(raw),
                "0x{raw:08X} must remain an alertable Windows fault"
            );
        }
        assert_eq!(
            classify_windows_exit_status(17),
            WindowsTermination::Ordinary(17)
        );
    }

    #[test]
    fn windows_exit_descriptions_keep_the_raw_hex_and_class() {
        assert_eq!(
            describe_exit(Some(0xFFFF_FFFFu32 as i32), None),
            "with Windows status 0xFFFFFFFF (origin unknown)"
        );
        assert_eq!(
            describe_exit(Some(0xC000_0409u32 as i32), None),
            "with Windows status 0xC0000409 (fault)"
        );
    }

    #[test]
    fn session_terminate_exit_description_pins_the_sentry_wire_value() {
        // Sentry reports this status as a positive decimal, whereas the
        // Windows classifier reads its bit pattern. Pin both spellings so a
        // future refactor cannot accidentally turn it back into exit:1073807364.
        const OBSERVED_SESSION_TERMINATE_EXIT: i32 = 1_073_807_364;
        assert_eq!(OBSERVED_SESSION_TERMINATE_EXIT as u32, 0x4001_0004);
        assert_eq!(
            describe_exit(Some(OBSERVED_SESSION_TERMINATE_EXIT), None),
            "with Windows status 0x40010004 (session terminate)"
        );
    }

    #[test]
    fn termination_fingerprint_separates_exit_codes_from_signals() {
        assert_eq!(termination_fingerprint_token(Some(2), None), "exit:2");
        assert_eq!(termination_fingerprint_token(None, Some(2)), "signal:2");
        assert_eq!(termination_fingerprint_token(Some(126), None), "exit:126");
        assert_eq!(
            termination_fingerprint_token(Some(WINDOWS_CONTROL_C_EXIT), None),
            "windows:console-control"
        );
        assert_eq!(
            termination_fingerprint_token(Some(0xFFFF_FFFFu32 as i32), None),
            "windows:status-ffffffff"
        );
        assert_eq!(
            termination_fingerprint_token(Some(0xC000_0409u32 as i32), None),
            "windows:fault:0xC0000409"
        );
        assert_ne!(
            termination_fingerprint_token(Some(2), None),
            termination_fingerprint_token(Some(126), None)
        );
    }

    #[test]
    fn session_terminate_fingerprint_is_windows_scoped_not_a_posix_exit() {
        const OBSERVED_SESSION_TERMINATE_EXIT: i32 = 1_073_807_364;
        assert_eq!(OBSERVED_SESSION_TERMINATE_EXIT as u32, 0x4001_0004);
        assert_eq!(
            termination_fingerprint_token(Some(OBSERVED_SESSION_TERMINATE_EXIT), None),
            "windows:session-terminate"
        );
        assert_ne!(
            termination_fingerprint_token(Some(OBSERVED_SESSION_TERMINATE_EXIT), None),
            "exit:1073807364"
        );
    }

    #[test]
    fn termination_fingerprint_isolates_invalid_dual_statuses() {
        assert_eq!(
            termination_fingerprint_token(Some(2), Some(2)),
            "invalid:exit:2+signal:2"
        );
        assert_eq!(termination_fingerprint_token(None, None), "unknown");
    }

    #[test]
    fn posix_termination_tokens_and_descriptions_are_byte_identical() {
        for (code, signal, token, description) in [
            (Some(126), None, "exit:126", "with code 126"),
            (Some(127), None, "exit:127", "with code 127"),
            (Some(2), None, "exit:2", "with code 2"),
            (
                None,
                Some(11),
                "signal:11",
                "crashed with SIGSEGV (segfault)",
            ),
        ] {
            assert_eq!(termination_fingerprint_token(code, signal), token);
            assert_eq!(describe_exit(code, signal), description);
        }
        assert_eq!(
            termination_fingerprint_token(Some(2), Some(11)),
            "invalid:exit:2+signal:11"
        );
        assert_eq!(describe_exit(None, None), "with code unknown");
    }

    // ── RunTotals ────────────────────────────────────────────────────────

    use crate::events::{
        SyncAllCompleteEvent, SyncAuthErrorEvent, SyncCompleteEvent, SyncProgressEvent,
    };

    fn complete(company: &str, conflicts: u32, aborted: bool) -> SyncEvent {
        SyncEvent::Complete(SyncCompleteEvent {
            company: company.to_string(),
            files_downloaded: 0,
            bytes_downloaded: 0,
            files_skipped: 0,
            conflicts,
            aborted,
            files_tombstoned: None,
            files_refused_stale: None,
        })
    }

    #[test]
    fn test_run_totals_default_is_zero() {
        let t = RunTotals::default();
        assert_eq!(t.conflicts, 0);
        assert_eq!(t.runner_error_rollup.tag_value(), None);
    }

    #[test]
    fn runner_error_rollup_is_fixed_vocabulary_and_never_leaks_path_or_message() {
        let path = r"C:\Users\Ada\hq\companies\personal\secret-plan.md";
        let raw_message = format!("EPERM: rename '{path}.hq-tmp-a1b2' -> '{path}'");
        let mut totals = RunTotals::default();
        totals.record_error(&make_company_error(Some("personal"), path, &raw_message));
        totals.record_error(&make_company_error(
            Some("personal"),
            "another-private-path.md",
            "EPERM: operation not permitted",
        ));
        totals.record_error(&make_company_error(
            Some("personal"),
            "ignored-path.md",
            "EACCES: access denied",
        ));

        let tag = totals
            .runner_error_rollup
            .tag_value()
            .expect("error counts");
        assert_eq!(tag, "EPERM:2,EACCES:1");
        assert!(!tag.contains(path));
        assert!(!tag.contains("hq-tmp-a1b2"));
        assert!(!tag.contains("operation not permitted"));
    }

    #[test]
    fn runner_error_rollup_fingerprint_token_is_dominant_class_and_permutation_stable() {
        let private_path = r"C:\Users\Ada\hq\companies\personal\secret-plan.md";
        let records = [
            (
                "personal",
                format!(
                    "EPERM: operation not permitted, rename '{private_path}.hq-tmp-a1b2' -> '{private_path}'"
                ),
            ),
            (
                "health",
                format!("Unauthorized: cognito token rejected, open '{private_path}'"),
            ),
            (
                "personal",
                format!(
                    "EPERM: operation not permitted, rename '{private_path}.hq-tmp-c3d4' -> '{private_path}'"
                ),
            ),
            (
                "health",
                format!("Unauthorized: cognito token rejected, open '{private_path}'"),
            ),
        ];

        let mut first = RunTotals::default();
        for (company, message) in &records {
            first.record_error(&make_company_error(Some(company), private_path, message));
        }

        let mut permuted = RunTotals::default();
        for (company, message) in records.iter().rev() {
            permuted.record_error(&make_company_error(Some(company), private_path, message));
        }

        assert_eq!(first.runner_error_rollup.fingerprint_token(), "eperm");
        assert_eq!(
            permuted.runner_error_rollup.fingerprint_token(),
            "eperm",
            "ties must use the fixed RunnerErrorClass declaration order"
        );
        assert_eq!(
            first.runner_error_ops.tag_value().as_deref(),
            Some("rename:2,open:2")
        );
        assert_eq!(
            permuted.runner_error_ops.tag_value(),
            first.runner_error_ops.tag_value()
        );
        assert_eq!(first.runner_error_company_count(), 2);
        assert_eq!(permuted.runner_error_company_count(), 2);
        assert_eq!(
            RunTotals::default().runner_error_rollup.fingerprint_token(),
            "none"
        );

        let mut readlink_einval = RunTotals::default();
        readlink_einval.record_error(&make_company_error(
            Some("personal"),
            private_path,
            &format!("EINVAL: invalid argument, readlink '{private_path}'"),
        ));
        assert_eq!(
            readlink_einval.runner_error_rollup.fingerprint_token(),
            "other"
        );
        assert_eq!(
            readlink_einval.runner_error_ops.tag_value().as_deref(),
            Some("readlink:1")
        );
    }

    #[test]
    fn classify_runner_error_op_is_fixed_vocabulary_and_never_leaks_path_or_message() {
        let private_path = r"C:\Users\Ada\hq\companies\personal\secret-plan.md";
        let cases = [
            ("rename", RunnerErrorOp::Rename),
            ("unlink", RunnerErrorOp::Unlink),
            ("open", RunnerErrorOp::Open),
            ("mkdir", RunnerErrorOp::Mkdir),
            ("rmdir", RunnerErrorOp::Rmdir),
            ("symlink", RunnerErrorOp::Symlink),
            ("readlink", RunnerErrorOp::Readlink),
            ("stat", RunnerErrorOp::Stat),
            ("lstat", RunnerErrorOp::Lstat),
            ("chmod", RunnerErrorOp::Chmod),
            ("copyfile", RunnerErrorOp::Copyfile),
            ("utimes", RunnerErrorOp::Utimes),
            ("scandir", RunnerErrorOp::Scandir),
            ("read", RunnerErrorOp::Read),
            ("write", RunnerErrorOp::Write),
            ("access", RunnerErrorOp::Access),
        ];

        for (operation, expected) in cases {
            let raw_message =
                format!("EPERM: operation not permitted, {operation} '{private_path}.hq-tmp-a1b2'");
            let actual = classify_runner_error_op(&raw_message);
            assert_eq!(
                actual, expected,
                "must recognize Node's {operation} errno shape"
            );
            assert_eq!(actual.as_str(), operation);
            assert!(!actual.as_str().contains(private_path));
            assert!(!actual.as_str().contains("hq-tmp-a1b2"));
        }

        assert_eq!(
            classify_runner_error_op(&format!("custom failure at '{private_path}'")),
            RunnerErrorOp::Other
        );
    }

    #[test]
    fn fatal_runner_signatures_are_evidence_only() {
        let mut totals = RunTotals::default();
        totals.record_stderr_line("fatal error: unrecoverable runtime failure");
        assert!(totals.saw_fatal_runner_signature);
        assert!(!totals.saw_node_too_old);
        assert!(is_fatal_runner_signature("UnhandledRejection: boom"));
        assert!(!is_fatal_runner_signature("EPERM: operation not permitted"));
    }

    #[test]
    fn runner_fatal_class_is_fixed_vocabulary_and_never_copies_stderr() {
        let private_path = r"C:\\Users\\Ada\\hq\\companies\\personal\\secret-plan.md";
        let libuv_assertion = format!(
            "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\\\win\\\\async.c, line 76: {private_path}"
        );
        let permission_denied =
            format!("sh: {private_path}/node_modules/.bin/hq-sync-runner: Permission denied");

        assert_eq!(
            classify_runner_fatal_class(&libuv_assertion),
            RunnerFatalClass::LibuvAssert
        );
        assert_eq!(
            classify_runner_fatal_class(&permission_denied),
            RunnerFatalClass::ExecPermissionDenied
        );
        assert_eq!(
            classify_runner_fatal_class("FATAL ERROR: JavaScript heap out of memory"),
            RunnerFatalClass::HeapOom
        );
        assert_eq!(
            classify_runner_fatal_class("thread 'main' panicked at 'boom'"),
            RunnerFatalClass::RustPanic
        );
        assert_eq!(
            classify_runner_fatal_class("UnhandledRejection: boom"),
            RunnerFatalClass::NodeFatal
        );
        assert_eq!(
            classify_runner_fatal_class("sh: hq-sync-runner: command not found"),
            RunnerFatalClass::ExecNotFound
        );
        assert_eq!(
            classify_runner_fatal_class(
                "TypeError: diagnostics_channel.tracingChannel is not a function"
            ),
            RunnerFatalClass::NodeTooOld
        );
        assert_eq!(
            classify_runner_fatal_class("EPERM: operation not permitted"),
            RunnerFatalClass::None
        );
        assert_eq!(
            classify_runner_fatal_class("EACCES: permission denied, open /private/user-file"),
            RunnerFatalClass::None,
            "ordinary runner file errors are not launch failures"
        );
        assert_eq!(
            classify_runner_fatal_class(
                "ENOENT: no such file or directory, open /private/user-file"
            ),
            RunnerFatalClass::None,
            "ordinary runner file errors are not launch failures"
        );
        assert_eq!(classify_runner_fatal_class(""), RunnerFatalClass::None);

        let token = classify_runner_fatal_class(&libuv_assertion).as_str();
        assert_eq!(token, "libuv_assert");
        assert!(!token.contains("Ada"));
        assert!(!token.contains("secret-plan"));
    }

    #[test]
    fn fatal_diagnostics_do_not_change_termination_fingerprints() {
        for (code, signal, expected) in [
            (Some(-1_073_740_791), None, "windows:fault:0xC0000409"),
            (Some(126), None, "exit:126"),
            (Some(2), None, "exit:2"),
            (Some(17), None, "exit:17"),
            (
                Some(0xC000_0005u32 as i32),
                None,
                "windows:fault:0xC0000005",
            ),
            (Some(0xC000_013Au32 as i32), None, "windows:console-control"),
            (
                Some(0x4001_0004u32 as i32),
                None,
                "windows:session-terminate",
            ),
        ] {
            assert_eq!(termination_fingerprint_token(code, signal), expected);
        }
    }

    #[test]
    fn well_known_windows_fault_symbols_are_fixed_vocabulary() {
        assert_eq!(
            windows_fault_symbol(0xC000_0409u32 as i32),
            Some("STATUS_STACK_BUFFER_OVERRUN")
        );
        assert_eq!(
            windows_fault_symbol(0xC000_0005u32 as i32),
            Some("ACCESS_VIOLATION")
        );
        assert_eq!(
            windows_fault_symbol(0xC000_013Au32 as i32),
            Some("CONTROL_C_EXIT")
        );
        assert_eq!(
            windows_fault_symbol(0x8000_0003u32 as i32),
            Some("BREAKPOINT")
        );
        assert_eq!(windows_fault_symbol(17), None);
    }

    #[test]
    fn test_accumulate_ignores_setup_needed() {
        let mut t = RunTotals::default();
        t.accumulate(&SyncEvent::SetupNeeded);
        assert_eq!(t.conflicts, 0);
    }

    #[test]
    fn test_accumulate_ignores_progress() {
        let mut t = RunTotals::default();
        t.accumulate(&SyncEvent::Progress(SyncProgressEvent {
            company: "x".to_string(),
            path: "y".to_string(),
            bytes: 0,
            message: None,
            direction: None,
            deleted: None,
            author: None,
        }));
        assert_eq!(t.conflicts, 0);
    }

    #[test]
    fn test_accumulate_ignores_all_complete() {
        let mut t = RunTotals {
            conflicts: 4,
            ..Default::default()
        };
        t.accumulate(&SyncEvent::AllComplete(SyncAllCompleteEvent {
            companies_attempted: 1,
            files_downloaded: 0,
            bytes_downloaded: 0,
            errors: vec![],
        }));
        // AllComplete is the signal to read, not accumulate — totals unchanged.
        assert_eq!(t.conflicts, 4);
    }

    #[test]
    fn test_accumulate_sums_conflicts_across_completes() {
        let mut t = RunTotals::default();
        t.accumulate(&complete("a", 3, false));
        t.accumulate(&complete("b", 2, true)); // aborted companies still contribute
        assert_eq!(t.conflicts, 5);
    }

    #[test]
    fn test_accumulate_zero_conflicts_is_noop() {
        let mut t = RunTotals {
            conflicts: 10,
            ..Default::default()
        };
        t.accumulate(&complete("a", 0, false));
        assert_eq!(t.conflicts, 10);
    }

    #[test]
    fn test_accumulate_saturates_on_overflow() {
        let mut t = RunTotals {
            conflicts: u32::MAX,
            ..Default::default()
        };
        t.accumulate(&complete("a", 1, false));
        assert_eq!(t.conflicts, u32::MAX);
    }

    #[test]
    fn auth_error_is_terminal_even_with_exit_zero() {
        let mut totals = RunTotals::default();
        totals.accumulate(&SyncEvent::AuthError(SyncAuthErrorEvent {
            message: "Sign in to keep sync moving".to_string(),
        }));

        assert!(totals.saw_auth_error);
        assert!(!should_synthesize_all_complete(
            true,
            totals.all_complete_seen,
            totals.saw_auth_error,
        ));
    }

    #[test]
    fn successful_early_exit_still_synthesizes_when_auth_is_healthy() {
        assert!(should_synthesize_all_complete(true, false, false));
        assert!(!should_synthesize_all_complete(false, false, false));
        assert!(!should_synthesize_all_complete(true, true, false));
    }

    // ── is_entity_not_yet_provisioned ────────────────────────────────────────

    fn make_company_error(company: Option<&str>, path: &str, message: &str) -> SyncErrorEvent {
        SyncErrorEvent {
            company: company.map(str::to_string),
            path: path.to_string(),
            message: message.to_string(),
        }
    }

    #[test]
    fn test_not_provisioned_404_not_found_in_message() {
        let err = make_company_error(
            Some("acme"),
            "(company)",
            "Failed to fetch entity cmp_01ABC: 404 company/entity not found",
        );
        assert!(is_entity_not_yet_provisioned(&err));
    }

    #[test]
    fn test_not_provisioned_no_bucket() {
        let err = make_company_error(
            Some("newco"),
            "(company)",
            "Entity cmp_01ABC (newco) has no bucket provisioned. Run VLT-2 bucket provisioning first.",
        );
        assert!(is_entity_not_yet_provisioned(&err));
    }

    #[test]
    fn test_not_provisioned_case_insensitive() {
        // Both "entity" and "not found" must be present; case-insensitive.
        let err = make_company_error(Some("acme"), "(company)", "Entity cmp_XYZ NOT FOUND");
        assert!(is_entity_not_yet_provisioned(&err));
    }

    #[test]
    fn test_not_provisioned_generic_not_found_excluded() {
        // "not found" without "entity" must NOT match — protects against auth
        // errors like "Token not found" or "Session not found".
        let err = make_company_error(Some("acme"), "(company)", "Token not found");
        assert!(!is_entity_not_yet_provisioned(&err));
    }

    #[test]
    fn test_not_provisioned_file_level_error_excluded() {
        // File-level errors on real paths must not be swallowed.
        let err = make_company_error(Some("acme"), "docs/secret.md", "not found");
        assert!(!is_entity_not_yet_provisioned(&err));
    }

    #[test]
    fn test_not_provisioned_different_company_error_not_matched() {
        // A real per-company failure (e.g. STS 500) must surface as an error.
        let err = make_company_error(
            Some("acme"),
            "(company)",
            "STS vend failed for cmp_01ABC: 500 Internal Server Error",
        );
        assert!(!is_entity_not_yet_provisioned(&err));
    }

    #[test]
    fn test_not_provisioned_discovery_error_still_matches_predicate() {
        // The predicate checks only path + message; it has no knowledge of company.
        // A None-company error can still match the predicate — the caller
        // (classify_error_event) is responsible for the None guard.
        let err = make_company_error(
            None,
            "(company)",
            "Failed to fetch entity cmp_01ABC: 404 company/entity not found",
        );
        assert!(is_entity_not_yet_provisioned(&err));
    }

    // ── is_transient_network_error ───────────────────────────────────────────

    #[test]
    fn test_transient_network_error_matches_known_markers() {
        // The exact shape the runner's `describeError` surfaces for the
        // latest-event scenario (HQ-SYNC-WEB-6): a socket reset mid-fanout.
        assert!(is_transient_network_error(
            "TimeoutError code=ECONNRESET read ECONNRESET"
        ));
        assert!(is_transient_network_error(
            "connect ECONNREFUSED 10.0.0.1:443"
        ));
        assert!(is_transient_network_error(
            "Client network socket disconnected: socket hang up"
        ));
        assert!(is_transient_network_error(
            "request to https://vault failed, reason: ETIMEDOUT"
        ));
        assert!(is_transient_network_error(
            "getaddrinfo EAI_AGAIN hqapi.getindigo.ai"
        ));
        // Case-insensitive.
        assert!(is_transient_network_error("Econnreset"));
    }

    #[test]
    fn test_transient_network_error_excludes_real_defects() {
        // Filesystem + HTTP-status + opaque errors are NOT transient and must
        // keep alerting.
        assert!(!is_transient_network_error(
            "EISDIR: illegal operation on a directory, read"
        ));
        assert!(!is_transient_network_error("Unknown http=403 UnknownError"));
        assert!(!is_transient_network_error(
            "Failed to fetch entity cmp_01ABC: 404 {\"error\":\"gone\"}"
        ));
        assert!(!is_transient_network_error(
            "ScopeShrinkBlockedError code=SCOPE_SHRINK_BLOCKED"
        ));
        assert!(!is_transient_network_error("something unexpected"));
    }

    // ── is_alertable_error ───────────────────────────────────────────────────

    #[test]
    fn test_alertable_false_for_not_yet_provisioned() {
        // The vault's correct 404 is benign — the UI already absorbs it as an
        // empty sync; re-alerting at exit is the noise this fix removes.
        let err = make_company_error(
            Some("newco"),
            "(company)",
            "Failed to fetch entity cmp_01ABC: 404 company/entity not found",
        );
        assert!(!is_alertable_error(&err));
    }

    #[test]
    fn test_alertable_false_for_transient_network() {
        let err = make_company_error(
            Some("personal"),
            "(company)",
            "TimeoutError code=ECONNRESET read ECONNRESET",
        );
        assert!(!is_alertable_error(&err));
    }

    #[test]
    fn test_alertable_false_for_expected_acl_scope_skip() {
        // HQ-SYNC-WEB-6: a per-file 403 SCOPE_EXCEEDS_PARENT skip — the file is
        // kept local-only and the user is told to grant the path. Benign on
        // BOTH the HEAD and PUT skip messages the runner emits.
        let head = make_company_error(
            Some("romy"),
            "data/homepage-img-src/hero-lineup.png",
            "skipped: outside granted ACL scope (server returned 403 \
             SCOPE_EXCEEDS_PARENT / access denied on HEAD). Grant this path to \
             push it, or it stays local-only.",
        );
        assert!(!is_alertable_error(&head));
        let put = make_company_error(
            Some("romy"),
            "projects/homepage/index.html",
            "skipped: outside granted ACL scope (server returned 403 \
             SCOPE_EXCEEDS_PARENT / access denied on PUT). Grant this path to \
             push it, or it stays local-only.",
        );
        assert!(!is_alertable_error(&put));
    }

    #[test]
    fn test_alertable_true_for_real_defect() {
        // EISDIR (a genuine bug) and a 403 (auth) must still alert.
        let eisdir = make_company_error(
            Some("acme"),
            "(company)",
            "EISDIR: illegal operation on a directory, read",
        );
        assert!(is_alertable_error(&eisdir));
        let forbidden = make_company_error(
            Some("acme"),
            "(company)",
            "STS /sts/vend-self failed: 403 {\"error\":\"denied\"}",
        );
        assert!(is_alertable_error(&forbidden));
    }

    #[test]
    fn test_alertable_true_for_real_file_level_error() {
        // A genuine per-file failure (not an expected ACL-scope skip) DOES drive
        // the runner's exit-2 tally and must keep alerting — file level no
        // longer gets a blanket pass.
        let err = make_company_error(
            Some("acme"),
            "docs/a.md",
            "EISDIR: illegal operation on a directory, read",
        );
        assert!(is_alertable_error(&err));
    }

    // ── should_alert_on_nonzero_exit ─────────────────────────────────────────

    #[test]
    fn runner_exit_disposition_precedence_is_pinned() {
        use RunnerExitDisposition::{
            Alert, Ignore, NodeTooOld, TransientRetry, WindowsConsoleControl,
        };

        // This matrix preserves the pre-existing manual-sync dispatch ordering
        // for every non-75 input while pinning the new hq-cloud retry contract.
        let cases = [
            (None, Some(SIGTERM_SIGNAL), false, false, false, Ignore),
            (
                Some(WINDOWS_CONTROL_C_EXIT),
                None,
                false,
                false,
                false,
                WindowsConsoleControl,
            ),
            (
                Some(RUNNER_OPERATION_LOCKED_EXIT),
                None,
                true,
                true,
                false,
                Ignore,
            ),
            (Some(1), None, false, false, true, NodeTooOld),
            (None, Some(SIGTERM_SIGNAL), false, false, true, NodeTooOld),
            (
                Some(WINDOWS_CONTROL_C_EXIT),
                None,
                false,
                false,
                true,
                NodeTooOld,
            ),
            (
                Some(RUNNER_OPERATION_LOCKED_EXIT),
                None,
                false,
                false,
                true,
                NodeTooOld,
            ),
            (Some(2), None, true, false, false, Ignore),
            (
                Some(RUNNER_TRANSIENT_RETRY_EXIT),
                None,
                true,
                true,
                false,
                TransientRetry,
            ),
            (
                Some(RUNNER_TRANSIENT_RETRY_EXIT),
                None,
                false,
                false,
                false,
                TransientRetry,
            ),
            (
                Some(RUNNER_TRANSIENT_RETRY_EXIT),
                None,
                true,
                true,
                true,
                NodeTooOld,
            ),
            (Some(2), None, true, true, false, Alert),
            (Some(1), None, false, false, false, Alert),
        ];

        for (code, signal, saw_error, saw_alertable_error, saw_node_too_old, expected) in cases {
            assert_eq!(
                classify_runner_exit_disposition(
                    code,
                    signal,
                    saw_error,
                    saw_alertable_error,
                    saw_node_too_old,
                ),
                expected,
                "unexpected disposition for code={code:?}, signal={signal:?}, error={saw_error}, alertable={saw_alertable_error}, node_too_old={saw_node_too_old}"
            );
        }
    }

    #[test]
    fn should_alert_is_only_a_projection_of_runner_exit_disposition() {
        let cases = [
            (None, Some(SIGTERM_SIGNAL), false, false, false),
            (Some(WINDOWS_CONTROL_C_EXIT), None, false, false, false),
            (Some(RUNNER_OPERATION_LOCKED_EXIT), None, true, true, false),
            (Some(1), None, false, false, true),
            (Some(2), None, true, false, false),
            (Some(RUNNER_TRANSIENT_RETRY_EXIT), None, true, true, false),
            (Some(RUNNER_TRANSIENT_RETRY_EXIT), None, false, false, false),
            (Some(2), None, true, true, false),
            (Some(1), None, false, false, false),
        ];

        for (code, signal, saw_error, saw_alertable_error, saw_node_too_old) in cases {
            assert_eq!(
                should_alert_on_nonzero_exit(
                    code,
                    signal,
                    saw_error,
                    saw_alertable_error,
                    saw_node_too_old,
                ),
                matches!(
                    classify_runner_exit_disposition(
                        code,
                        signal,
                        saw_error,
                        saw_alertable_error,
                        saw_node_too_old,
                    ),
                    RunnerExitDisposition::Alert
                )
            );
        }
    }

    #[test]
    fn test_exit_alert_suppressed_for_operation_locked() {
        // Exit 17 = another sync holds the lock — a normal concurrent race.
        assert!(!should_alert_on_nonzero_exit(
            Some(17),
            None,
            false,
            false,
            false
        ));
        // Even if it somehow co-occurred with an alertable error, locked wins.
        assert!(!should_alert_on_nonzero_exit(
            Some(17),
            None,
            true,
            true,
            false
        ));
    }

    #[test]
    fn test_exit_alert_suppressed_for_sigterm_cancellation() {
        // HQ-SYNC-WEB-H: the runner killed by SIGTERM (signal 15, code None) is
        // OUR own cancel_process_impl ending the run — Stop button, timeout
        // watchdog, app quit, or a newer sync superseding this one. An expected
        // cancellation must NEVER alert, even with no protocol seen…
        assert!(!should_alert_on_nonzero_exit(
            None,
            Some(15),
            false,
            false,
            false
        ));
        // …and even if company errors (benign or alertable) were mid-flight when
        // the cancel landed — the cancellation is the cause, not the errors.
        assert!(!should_alert_on_nonzero_exit(
            None,
            Some(15),
            true,
            false,
            false
        ));
        assert!(!should_alert_on_nonzero_exit(
            None,
            Some(15),
            true,
            true,
            false
        ));
    }

    #[test]
    fn windows_console_control_exit_is_exact_and_suppressed_for_manual_sync() {
        assert!(is_windows_console_control_exit(
            Some(WINDOWS_CONTROL_C_EXIT),
            None
        ));
        for code in [
            -1073741509, // adjacent non-control NTSTATUS
            -1073741819, // 0xC0000005 access violation
            -1073741571, // 0xC00000FD stack overflow
            0,
            1,
            2,
            RUNNER_OPERATION_LOCKED_EXIT,
            126,
            127,
        ] {
            assert!(
                !is_windows_console_control_exit(Some(code), None),
                "only STATUS_CONTROL_C_EXIT may be suppressed: {code}"
            );
        }
        assert!(!is_windows_console_control_exit(None, None));
        assert!(!is_windows_console_control_exit(
            Some(WINDOWS_CONTROL_C_EXIT),
            Some(SIGTERM_SIGNAL)
        ));

        for (saw_error, saw_alertable_error, saw_node_too_old) in [
            (false, false, false),
            (true, false, false),
            (true, true, false),
            (true, true, true),
        ] {
            assert!(!should_alert_on_nonzero_exit(
                Some(WINDOWS_CONTROL_C_EXIT),
                None,
                saw_error,
                saw_alertable_error,
                saw_node_too_old,
            ));
        }

        for fault in [-1073741819, -1073741571, 126, 127] {
            assert!(should_alert_on_nonzero_exit(
                Some(fault),
                None,
                false,
                false,
                false,
            ));
        }
    }

    #[test]
    fn test_exit_alert_fires_for_genuine_crash_signals() {
        // A real crash signal is NOT a cancellation and must stay loud:
        // SIGSEGV (11) / SIGBUS (10) / SIGABRT (6) are crashes, and SIGKILL (9)
        // is an OOM or force-quit worth seeing — only SIGTERM is suppressed.
        assert!(should_alert_on_nonzero_exit(
            None,
            Some(11),
            false,
            false,
            false
        ));
        assert!(should_alert_on_nonzero_exit(
            None,
            Some(10),
            false,
            false,
            false
        ));
        assert!(should_alert_on_nonzero_exit(
            None,
            Some(6),
            false,
            false,
            false
        ));
        assert!(should_alert_on_nonzero_exit(
            None,
            Some(9),
            false,
            false,
            false
        ));
    }

    #[test]
    fn test_exit_alert_suppressed_when_all_errors_benign() {
        // The HQ-SYNC-WEB-6 shape: exit 2 driven solely by benign errors
        // (per-file ACL-scope skips, a not-provisioned 404, or a transient
        // ECONNRESET) → saw_error && !saw_alertable_error → no alert.
        assert!(!should_alert_on_nonzero_exit(
            Some(2),
            None,
            true,
            false,
            false
        ));
    }

    #[test]
    fn test_exit_alert_fires_for_real_error() {
        // exit 2 with at least one alertable error (e.g. EISDIR) → alert.
        assert!(should_alert_on_nonzero_exit(
            Some(2),
            None,
            true,
            true,
            false
        ));
    }

    #[test]
    fn test_exit_alert_fires_for_unexplained_exit() {
        // Non-zero exit with NO error event seen — runner panicked / was
        // OOM-killed before emitting protocol. This is the original
        // "bailed before a useful stream" signal and must keep alerting.
        assert!(should_alert_on_nonzero_exit(
            Some(1),
            None,
            false,
            false,
            false
        ));
        // Signal-kill with neither code nor a recognized signal is likewise
        // unexplained (only a SIGTERM cancel is suppressed).
        assert!(should_alert_on_nonzero_exit(
            None, None, false, false, false
        ));
    }

    #[test]
    fn test_exit_alert_suppressed_for_node_too_old() {
        assert!(!should_alert_on_nonzero_exit(
            Some(1),
            None,
            false,
            false,
            true
        ));
        assert!(!should_alert_on_nonzero_exit(
            Some(2),
            None,
            true,
            true,
            true
        ));
    }

    // ── accumulate / record_error: any-level error classification ────────────

    #[test]
    fn test_accumulate_flags_benign_company_error_not_alertable() {
        let mut t = RunTotals::default();
        t.accumulate(&SyncEvent::Error(make_company_error(
            Some("personal"),
            "(company)",
            "TimeoutError code=ECONNRESET read ECONNRESET",
        )));
        assert!(t.saw_error);
        assert!(!t.saw_alertable_error);
    }

    #[test]
    fn test_accumulate_flags_real_company_error_alertable() {
        let mut t = RunTotals::default();
        t.accumulate(&SyncEvent::Error(make_company_error(
            Some("acme"),
            "(company)",
            "EISDIR: illegal operation on a directory, read",
        )));
        assert!(t.saw_error);
        assert!(t.saw_alertable_error);
    }

    #[test]
    fn test_accumulate_mixed_errors_stay_alertable() {
        // A benign error must not "downgrade" a real one seen in the same run.
        let mut t = RunTotals::default();
        t.accumulate(&SyncEvent::Error(make_company_error(
            Some("personal"),
            "(company)",
            "TimeoutError code=ECONNRESET read ECONNRESET",
        )));
        t.accumulate(&SyncEvent::Error(make_company_error(
            Some("acme"),
            "(company)",
            "EISDIR: illegal operation on a directory, read",
        )));
        assert!(t.saw_error);
        assert!(t.saw_alertable_error);
    }

    #[test]
    fn test_accumulate_file_level_acl_scope_skip_benign() {
        // A per-file ACL-scope skip (the HQ-SYNC-WEB-6 flood) now feeds the
        // alert decision — seen, but NOT alertable — so a run whose only errors
        // are these skips suppresses the exit alert.
        let mut t = RunTotals::default();
        t.accumulate(&SyncEvent::Error(make_company_error(
            Some("romy"),
            "data/homepage-img-src/hero-lineup.png",
            "skipped: outside granted ACL scope (server returned 403 \
             SCOPE_EXCEEDS_PARENT / access denied on HEAD).",
        )));
        assert!(t.saw_error);
        assert!(!t.saw_alertable_error);
    }

    #[test]
    fn test_accumulate_file_level_real_error_alertable() {
        // A genuine per-file failure now correctly counts as alertable (it
        // drives the runner's exit-2 tally just like a company-level error).
        let mut t = RunTotals::default();
        t.accumulate(&SyncEvent::Error(make_company_error(
            Some("acme"),
            "docs/a.md",
            "EISDIR: illegal operation on a directory, read",
        )));
        assert!(t.saw_error);
        assert!(t.saw_alertable_error);
    }

    #[test]
    fn test_record_error_from_parsed_stderr_acl_scope_line() {
        // End-to-end of the regression: the runner (hq-cloud PR #34) emits the
        // ACL-scope skip as an ndjson `error` line on STDERR. The stderr arm
        // parses it and records it; the run must then NOT alert on exit 2.
        let line = r#"{"type":"error","company":"romy","path":"projects/homepage/index.html","message":"skipped: outside granted ACL scope (server returned 403 SCOPE_EXCEEDS_PARENT / access denied on HEAD). Grant this path to push it, or it stays local-only."}"#;
        let event: SyncEvent =
            serde_json::from_str(line).expect("stderr ndjson error line should parse");
        let mut t = RunTotals::default();
        if let SyncEvent::Error(payload) = event {
            t.record_error(&payload);
        } else {
            panic!("expected SyncEvent::Error");
        }
        assert!(t.saw_error);
        assert!(!t.saw_alertable_error);
        assert!(!should_alert_on_nonzero_exit(
            Some(2),
            None,
            t.saw_error,
            t.saw_alertable_error,
            t.saw_node_too_old
        ));
    }

    #[test]
    fn test_node_too_old_signature_matches_crash_and_ebadengine() {
        assert!(is_node_too_old_signature(
            "TypeError: diagChan.tracingChannel is not a function"
        ));
        assert!(is_node_too_old_signature(
            "npm warn EBADENGINE Unsupported engine { required: { node: '>=20.0.0' }, current: { node: 'v19.3.0' } }"
        ));
    }

    #[test]
    fn test_node_too_old_signature_ignores_unrelated_stderr() {
        assert!(!is_node_too_old_signature("uploading projects/index.html"));
        assert!(!is_node_too_old_signature(
            "Error: connect ECONNRESET 10.0.0.1:443"
        ));
        assert!(!is_node_too_old_signature(
            "npm warn EBADENGINE required: { npm: '>=10' }"
        ));
    }

    #[test]
    fn test_record_stderr_line_flags_node_too_old_only() {
        let mut t = RunTotals::default();
        t.record_stderr_line("TypeError: diagChan.tracingChannel is not a function");
        assert!(t.saw_node_too_old);
        assert!(!t.saw_error);
        assert!(!t.saw_alertable_error);
    }

    // ── classify_error_event ─────────────────────────────────────────────────

    #[test]
    fn test_classify_error_event_not_provisioned_returns_complete() {
        // Entity 404: must convert to a zero-files SyncCompleteEvent.
        let err = make_company_error(
            Some("acme"),
            "(company)",
            "Failed to fetch entity cmp_01ABC: 404 company/entity not found",
        );
        let result = classify_error_event(&err);
        assert!(result.is_some());
        let complete = result.unwrap();
        assert_eq!(complete.company, "acme");
        assert_eq!(complete.files_downloaded, 0);
        assert_eq!(complete.bytes_downloaded, 0);
        assert_eq!(complete.files_skipped, 0);
        assert_eq!(complete.conflicts, 0);
        assert!(!complete.aborted);
    }

    #[test]
    fn test_classify_error_event_none_company_passes_through() {
        // Discovery-phase error (no company): must NOT be converted — return None.
        let err = make_company_error(
            None,
            "(company)",
            "Failed to fetch entity cmp_01ABC: 404 company/entity not found",
        );
        assert!(classify_error_event(&err).is_none());
    }

    #[test]
    fn test_classify_error_event_real_error_passes_through() {
        // A real per-company failure (STS 500): must NOT be converted — return None.
        let err = make_company_error(
            Some("acme"),
            "(company)",
            "STS vend failed for cmp_01ABC: 500 Internal Server Error",
        );
        assert!(classify_error_event(&err).is_none());
    }

    #[test]
    fn test_classify_error_event_no_bucket_returns_complete() {
        // "no bucket provisioned" path also converts correctly.
        let err = make_company_error(
            Some("newco"),
            "(company)",
            "Entity cmp_01ABC (newco) has no bucket provisioned. Run VLT-2 bucket provisioning first.",
        );
        let result = classify_error_event(&err);
        assert!(result.is_some());
        assert_eq!(result.unwrap().company, "newco");
    }

    // ── auto-sync watcher Sentry policy (HQ-DESKTOP-3Z/40/41) ────────────

    #[test]
    fn watcher_exit_capture_policy_is_explicit_for_known_and_unknown_codes() {
        let cases = [
            (Some(0), None, WatcherExitCapturePolicy::Capture),
            (Some(1), None, WatcherExitCapturePolicy::LocalLogOnly),
            (Some(2), None, WatcherExitCapturePolicy::LocalLogOnly),
            (
                Some(126),
                None,
                WatcherExitCapturePolicy::CaptureRateLimited,
            ),
            (
                Some(127),
                None,
                WatcherExitCapturePolicy::CaptureRateLimited,
            ),
            // HQ-DESKTOP-3Z: unknown codes must stay visible, not guessed.
            (Some(221), None, WatcherExitCapturePolicy::Capture),
            (Some(99), None, WatcherExitCapturePolicy::Capture),
            (Some(2), Some(9), WatcherExitCapturePolicy::Capture),
        ];

        for (code, signal, expected) in cases {
            assert_eq!(
                watcher_exit_capture_policy(code, signal),
                expected,
                "code={code:?} signal={signal:?}"
            );
        }
    }

    #[test]
    fn exec_not_runnable_exits_escalate_only_after_a_sustained_streak() {
        let policy = watcher_exit_capture_policy(Some(127), None);
        for consecutive in [1, 2, 3] {
            assert!(
                !should_capture_watcher_exit(policy, consecutive),
                "one-off exec failure #{consecutive} must remain local"
            );
        }
        assert!(should_capture_watcher_exit(policy, 4));
        assert!(!should_capture_watcher_exit(policy, 5));
        assert!(should_capture_watcher_exit(policy, 8));
    }

    #[test]
    fn crash_loop_milestones_remain_first_then_powers_of_two() {
        for consecutive in [1, 2, 4, 8, 16, 32] {
            assert!(is_capture_milestone(consecutive));
        }
        for consecutive in [3, 5, 6, 7, 9, 15, 31] {
            assert!(!is_capture_milestone(consecutive));
        }
    }

    #[test]
    fn transient_spawn_resource_exhaustion_retries_without_capture() {
        let retry_cases = [
            (ErrorKind::WouldBlock, Some(35), SpawnFailurePlatform::Macos), // macOS EAGAIN/EWOULDBLOCK
            (ErrorKind::WouldBlock, Some(11), SpawnFailurePlatform::Linux), // Linux EAGAIN/EWOULDBLOCK
            (
                ErrorKind::OutOfMemory,
                Some(12),
                SpawnFailurePlatform::Linux,
            ), // ENOMEM
            (ErrorKind::Other, Some(24), SpawnFailurePlatform::Macos),      // EMFILE
            (ErrorKind::Other, Some(23), SpawnFailurePlatform::Linux),      // ENFILE
        ];
        for (kind, raw, platform) in retry_cases {
            assert_eq!(
                spawn_failure_capture_policy_for_platform(kind, raw, platform),
                SpawnFailureCapturePolicy::RetryAndLog,
                "kind={kind:?} raw={raw:?} platform={platform:?}"
            );
        }

        for (kind, raw, platform) in [
            (ErrorKind::NotFound, Some(2), SpawnFailurePlatform::Linux), // ENOENT
            (
                ErrorKind::PermissionDenied,
                Some(13),
                SpawnFailurePlatform::Macos,
            ), // EACCES
            // Raw Unix errno values are not portable; 11 must not silence an
            // unrelated Windows/other-platform spawn failure.
            (ErrorKind::Other, Some(11), SpawnFailurePlatform::Other),
        ] {
            assert_eq!(
                spawn_failure_capture_policy_for_platform(kind, raw, platform),
                SpawnFailureCapturePolicy::CaptureRateLimited,
                "kind={kind:?} raw={raw:?} platform={platform:?}"
            );
        }
    }

    #[test]
    fn spawn_failure_fingerprint_is_machine_path_independent() {
        let first = spawn_failure_fingerprint_token(ErrorKind::NotFound, Some(2));
        let second = spawn_failure_fingerprint_token(ErrorKind::NotFound, None);
        assert_eq!(first, second);
        assert_eq!(first, "not-found");
        assert!(!first.contains("/Users/"));
        assert!(!first.contains("/opt/homebrew/"));
        assert!(!first.contains("alice"));
    }

    #[test]
    fn runner_stack_shape_recognises_both_libuv_windows_spellings() {
        let backslash = vec![
            r"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76: C:\Users\Ada\secret-plan.md"
                .to_string(),
        ];
        let slash = vec![backslash[0].replace(r"src\win\async.c", "src/win/async.c")];

        let first = runner_stack_shape(&backslash);
        let second = runner_stack_shape(&slash);
        assert_ne!(first.shape, "all_redacted");
        assert_eq!(first, second);
    }

    #[test]
    fn runner_stack_shape_preserves_multi_line_frame_order_and_distinguishes_shapes() {
        let first = runner_stack_shape(&[
            "at node:internal/process/task_queues:95:5".to_string(),
            "private application frame C:\\Users\\Ada\\secret-plan.md:10:2".to_string(),
            "at node:events:517:28".to_string(),
        ]);
        let second = runner_stack_shape(&[
            "at node:events:517:28".to_string(),
            "private application frame C:\\Users\\Grace\\other.md:90:4".to_string(),
            "at node:internal/process/task_queues:95:5".to_string(),
        ]);

        assert_eq!(first.shape, "node_task_queues>app>node_events");
        assert_eq!(first.signature, "90c372213834ca17");
        assert_eq!(first.depth, 3);
        assert_eq!(first.redacted_frames, 1);
        assert_ne!(first.shape, second.shape);
        assert_ne!(first.signature, second.signature);
    }

    #[test]
    fn runner_stack_shape_recognises_named_v8_parenthesized_locations() {
        let shape = runner_stack_shape(&[
            "at Module._compile (node:internal/modules/cjs/loader:1356:14)".to_string(),
            "at EventEmitter.emit (node:events:517:28)".to_string(),
        ]);

        assert_eq!(shape.shape, "node_cjs_loader>node_events");
        assert_eq!(shape.depth, 2);
        assert_eq!(shape.redacted_frames, 0);
    }

    #[test]
    fn runner_stack_shape_has_an_honest_all_redacted_contract_and_eight_frame_cap() {
        let private_a = runner_stack_shape(&[
            "at C:\\Users\\Ada\\secret-plan.md:10:2".to_string(),
            "at company_private_symbol:20:4".to_string(),
        ]);
        let private_b = runner_stack_shape(&[
            "at /Users/grace/another-secret.md:99:8".to_string(),
            "at different_private_symbol:1:1".to_string(),
        ]);
        assert_eq!(private_a.shape, "all_redacted");
        assert_eq!(private_a.signature, "unknown");
        assert_eq!(private_a.redacted_frames, private_a.depth);
        assert_eq!(private_b.shape, "all_redacted");
        assert_eq!(private_b.signature, "unknown");

        let many = (0..12)
            .map(|_| "at node:fs:1:1".to_string())
            .collect::<Vec<_>>();
        let capped = runner_stack_shape(&many);
        assert_eq!(capped.depth, 8);
        assert_eq!(capped.shape.split('>').count(), 8);
        assert!(capped
            .shape
            .split('>')
            .all(|token| RUNNER_STACK_TOKENS.contains(&token)));
    }

    #[test]
    fn runner_stack_shape_rejects_marker_spoofing_outside_frame_positions() {
        for line in [
            "message embedding node:fs for a user",
            "home path /Users/Ada/node:internal/process/task_queues",
            "symbol core::panicking_helper",
            "file src/win/async.c.bak",
        ] {
            let shape = runner_stack_shape(&[line.to_string()]);
            assert_eq!(shape.shape, "all_redacted", "line={line}");
            assert_eq!(shape.signature, "unknown", "line={line}");
        }
    }

    #[test]
    fn shared_runner_phase_vocabulary_matches_the_watcher_contract() {
        let push: SyncEvent = serde_json::from_str(
            r#"{"type":"progress","company":"indigo","path":"private.md","bytes":1,"direction":"up"}"#,
        )
        .expect("progress event");
        let pull: SyncEvent = serde_json::from_str(
            r#"{"type":"progress","company":"indigo","path":"private.md","bytes":1,"direction":"down"}"#,
        )
        .expect("progress event");

        assert_eq!(runner_phase_from_event(&push), Some("push"));
        assert_eq!(runner_phase_from_event(&pull), Some("pull"));
        assert_eq!(
            runner_phase_elapsed_bucket(Duration::from_secs(59)),
            "under_1m"
        );
        assert_eq!(
            runner_phase_elapsed_bucket(Duration::from_secs(60)),
            "1m_to_5m"
        );
        assert_eq!(
            runner_phase_elapsed_bucket(Duration::from_secs(2 * 60 * 60)),
            "over_2h"
        );
    }
}
