use std::collections::HashSet;
use std::io::ErrorKind;
use std::time::Duration;

use crate::events::{SyncCompleteEvent, SyncErrorEvent, SyncEvent};
use crate::runner_error_shape::{
    classify_runner_error_cause, classify_runner_error_site, RunnerErrorCause,
    RunnerErrorCauseRollup, RunnerErrorCauseSignatureRollup, RunnerErrorHttpRollup,
    RunnerErrorPathRootRollup, RunnerErrorShapeRollup, RunnerErrorSite, RunnerErrorSiteRollup,
};
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
    /// Sticky: set true the first time ANY stderr line classifies as a
    /// genuine-crash fatal class (libuv assert / fatal syscall, Node check abort,
    /// Node fatal, V8 heap OOM, Rust panic) and never cleared for the rest of the
    /// pass. The disk-full suppression gate consults THIS rather than the retained
    /// `runner_fatal_class`, because last-non-None-wins lets a trailing npm
    /// companion line overwrite an earlier crash class — so a genuine crash that
    /// co-occurs with an ENOSPC error can never be masked into a disk-full
    /// suppression (HQ-DESKTOP-5D review, finding: preserve earlier crash
    /// evidence). Broader than `saw_fatal_runner_signature`, which keys on the
    /// narrower `is_fatal_runner_signature`.
    pub saw_genuine_crash_fatal: bool,
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
    /// The allow-listed libuv syscall identifier and the integer errno parsed
    /// from the same stderr line that set `runner_fatal_class`, present only
    /// when that class is `LibuvFatalSyscall`. They move in lockstep with the
    /// class (same last-wins line) so the three can never describe different
    /// lines. Content-safe: the identifier is always a fixed allow-listed
    /// constant, never copied runner bytes; the errno is a bare integer.
    /// Read through `runner_fatal_syscall()` / `runner_fatal_errno()`.
    runner_fatal_syscall: Option<&'static str>,
    runner_fatal_errno: Option<i64>,
    /// Content-safe identity of the last recognised libuv/Node assertion line
    /// this pass, present only when `runner_fatal_class` is an assertion class
    /// (`LibuvAssert` / `NodeCheckAbort`). Parsed from the SAME line that set the
    /// class, so the source token, integer line, and expression digest can never
    /// describe a different line than the class. All three are derived, never
    /// copied runner bytes. Read through `runner_assert_source()` /
    /// `runner_assert_line()` / `runner_assert_signature()`.
    runner_assert_source: Option<&'static str>,
    runner_assert_line: Option<i64>,
    runner_assert_signature: Option<String>,
    /// Content-safe message-shape counts for the runner errors seen in this pass.
    /// A third attribution axis beside the class/op rollups: it discriminates the
    /// hq-cloud pull-leg prose that both of those axes collapse to `OTHER`/`other`
    /// (the HQ-DESKTOP-4T unattributability). Every rendered token is chosen in
    /// code, never copied from a runner message.
    pub runner_error_shapes: RunnerErrorShapeRollup,
    /// Content-safe first-path-segment counts for per-file runner errors, so a
    /// flood confined to one subtree is distinguishable from a whole-company one
    /// without ever emitting a user path.
    pub runner_error_path_roots: RunnerErrorPathRootRollup,
    /// Content-safe HTTP-status counts for the runner errors seen this pass. The
    /// single most discriminating fact about an S3/STS or HTTP-shaped fault — the
    /// status is present verbatim in both the `describeError` `http=` key and the
    /// presigned `: <status>` tail, and was previously discarded on every axis.
    /// Every rendered token is chosen in code, never copied from a runner message.
    pub runner_error_http: RunnerErrorHttpRollup,
    /// Content-safe error-identity counts for the runner errors seen this pass —
    /// the hq-cloud error class or AWS error name behind the fault. A companion to
    /// the HTTP-status axis: together they turn the OTHER/other/unknown collapse
    /// into an actionable signal. Every rendered token is chosen in code.
    pub runner_error_causes: RunnerErrorCauseRollup,
    /// Content-safe correlator for the `unknown_named` cause residual: the SHA-256
    /// hex12 of a real-but-unlisted leading error identity. Lets the SAME fault
    /// recurring across machines be recognised as one producer even before its
    /// class name is added to the vocabulary — the drift-resilience this reopen
    /// adds. Never a runner byte: only a gated identifier is hashed.
    pub runner_error_cause_signature: RunnerErrorCauseSignatureRollup,
    /// Content-safe per-site counts of the runner error events seen this pass —
    /// the closed `RunnerErrorSite` vocabulary (`company`/`discovery`/`local_state`/
    /// `runner`/`scope`/`auth`/`file`). This is the single source of truth for BOTH
    /// the `runner_error_sites` rollup tag / fingerprint token AND the
    /// `runner_error_scope` split, so the two can never disagree. It names WHICH
    /// runner failure site produced the exit — the axis every one of the six
    /// HQ-DESKTOP-5M events lacked. Every token is chosen in code, never a path byte.
    pub runner_error_sites: RunnerErrorSiteRollup,
    /// Shape of the Node stack carried INSIDE a `(runner)` error record's message
    /// (an `err.stack` an uncaught rejection ships), computed by `runner_stack_shape`
    /// over the message's own lines. Stored ONLY when it recognised frames, so the
    /// exit reports a real stack shape instead of `all_redacted` when the stderr
    /// tail was ndjson records. Only the fixed-token `RunnerStackShape` is retained —
    /// never a message byte. `None` until such a record is seen.
    runner_embedded_stack_shape: Option<RunnerStackShape>,
    /// The most recent V8 GC-line heap figures this pass, as round-half-away MB
    /// `(used, total)`, last-wins until frozen at the first heap-OOM banner.
    /// Rounded at parse so `RunTotals` stays `Eq`; the rounded value is exactly
    /// what the banner would commit, so nothing observable changes. `None` until
    /// a GC line is parsed. See `record_heap_oom_stderr_line`.
    heap_gc_candidate: Option<(u64, u64)>,
    /// Highest round-half-away V8 GC heap-used MB seen before the first heap-OOM
    /// banner. It is retained independently of `heap_gc_candidate` so the
    /// numeric used/total fields keep their intentional final-reading semantics.
    heap_gc_peak_used_mb: Option<u64>,
    /// Retained V8 heap-OOM evidence for this pass (HQ-DESKTOP-55), created at
    /// the fatal banner and populated with a bounded native-frame capture. A V8
    /// heap OOM aborts the process, so this can never span the per-pass reset the
    /// watcher route applies on `AllComplete`. Memory-local: only fixed tokens,
    /// bounded integers, and a digest of the normalized symbols ever leave here.
    heap_oom: Option<HeapOomEvidence>,
}

/// Bounded, memory-local heap-OOM evidence. No field ever leaves the process as
/// text: the banner is a fixed constant, the MB figures are integers, and the
/// captured `frames` are normalized C++ symbols read only to derive a fixed-token
/// shape and a digest signature. See [`RunTotals::runner_heap_oom_stack`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct HeapOomEvidence {
    /// Which V8 fatal banner was seen: `reached_heap_limit`,
    /// `ineffective_mark_compacts`, or `other`. Always a fixed constant.
    banner: &'static str,
    /// Committed heap `(used, total)` MB frozen from the last GC candidate at the
    /// banner, or `None` when no GC line preceded it. Both-or-neither by
    /// construction.
    used_total_mb: Option<(u64, u64)>,
    /// Highest pre-banner GC heap-used reading, frozen at the banner. This feeds
    /// the fixed-vocabulary `runner_heap_peak_used_bucket` tag; it is separate
    /// from the last-reading `used_total_mb` retained for existing consumers.
    peak_used_mb: Option<u64>,
    /// Normalized native-stack symbols (ordinal/address/bracketed-suffix stripped),
    /// hard-capped at [`HEAP_OOM_FRAME_CAP`]. Memory-local — hashed into the
    /// signature and mapped to fixed tokens, never emitted raw.
    frames: Vec<String>,
    /// Set once the native-stack section ends, so trailing runner output can never
    /// append a spurious frame.
    frames_done: bool,
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
        // Additive attribution axes (never affect alerting/suppression): a
        // message shape for every error, and — for genuine per-file errors only —
        // a path root. None of the six non-file sentinels is a file path, so each
        // is counted by site (below) and never given a path root.
        self.runner_error_shapes.record(&err.message);
        // HTTP status and error identity for every error regardless of scope —
        // the company-scope path is precisely the one that currently yields
        // nothing, and its describeError message is where `http=`/the error name
        // live. Both parse only content-safe fixed vocabulary from err.message.
        self.runner_error_http.record(&err.message);
        self.runner_error_causes.record(&err.message);
        // Signature of the cause residual, recorded from the SAME message so an
        // `unknown_named` fault is correlatable across machines. Records nothing
        // for a matched cause or an `unknown_unnamed` residual.
        self.runner_error_cause_signature.record(&err.message);
        // Route by failure SITE (HQ-DESKTOP-5M). A genuine file path feeds the
        // per-file path-root rollup; every non-file sentinel — company, discovery,
        // local_state, runner, scope, auth — is counted by the site rollup ONLY, so
        // a producer sentinel is never fed to classify_runner_path_root (the `other`
        // collapse) nor miscounted as a per-file error. A `(runner)` record also
        // embeds an err.stack in its message, so shape it here (fixed tokens only,
        // never a message byte). The site rollup below counts every event.
        match classify_runner_error_site(&err.path) {
            RunnerErrorSite::File => self.runner_error_path_roots.record(&err.path),
            RunnerErrorSite::Runner => self.record_runner_embedded_stack(&err.message),
            _ => {}
        }
        self.runner_error_sites.record(&err.path);
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

    /// Compact, content-safe split of runner errors by failure SITE this pass,
    /// e.g. `company:1,file:7204` or `company:0,file:1,local_state:1`. Derived from
    /// the single `runner_error_sites` source of truth. `None` when no runner error
    /// was recorded, so no extra should be sent. Every count is an integer, never a
    /// path or name.
    ///
    /// Back-compat is load-bearing: the `company:N,file:N` PREFIX keeps its exact
    /// position and meaning, and the newer per-site segments — `discovery`,
    /// `local_state`, `runner`, `scope`, `auth` — append in that fixed order and
    /// ONLY when nonzero, so a run with only company and file errors renders exactly
    /// `company:N,file:N` as it always has and any existing dashboard/alert that
    /// parses that prefix is unaffected.
    pub fn runner_error_scope(&self) -> Option<String> {
        let sites = &self.runner_error_sites;
        let company = sites.count(RunnerErrorSite::Company);
        let file = sites.count(RunnerErrorSite::File);
        let discovery = sites.count(RunnerErrorSite::Discovery);
        let local_state = sites.count(RunnerErrorSite::LocalState);
        let runner = sites.count(RunnerErrorSite::Runner);
        let scope = sites.count(RunnerErrorSite::Scope);
        let auth = sites.count(RunnerErrorSite::Auth);
        let total = company
            .saturating_add(file)
            .saturating_add(discovery)
            .saturating_add(local_state)
            .saturating_add(runner)
            .saturating_add(scope)
            .saturating_add(auth);
        if total == 0 {
            return None;
        }
        let mut rendered = format!("company:{company},file:{file}");
        // Appended only when present, so the common company/file split is stable. The
        // `(auth)` site renders `identity`, matching RunnerErrorSite::as_str — a
        // denylist-safe spelling so the scope extra is never eaten by @password:filter.
        for (label, count) in [
            ("discovery", discovery),
            ("local_state", local_state),
            ("runner", runner),
            ("scope", scope),
            ("identity", auth),
        ] {
            if count > 0 {
                rendered.push_str(&format!(",{label}:{count}"));
            }
        }
        Some(rendered)
    }

    /// Shape the Node stack an uncaught rejection ships inside a `(runner)` error
    /// record's message (an `err.stack`), storing ONLY the fixed-token
    /// `RunnerStackShape` — never a message byte — and only when it recognised
    /// frames. An unrecognised body leaves the field `None`, so the exit stays
    /// honestly `all_redacted`. The FIRST recognised record wins; a later record
    /// never overwrites it, so a hostile flood cannot churn the stored shape.
    fn record_runner_embedded_stack(&mut self, message: &str) {
        if self.runner_embedded_stack_shape.is_some() {
            return;
        }
        // `runner_stack_shape` reads at most the first RUNNER_STACK_FRAME_CAP lines, so
        // cap the copy there: an attacker-influenced multi-megabyte message can never
        // be cloned in full here (the shape is identical), avoiding a second large
        // allocation precisely while reporting a possible OOM/runaway stack.
        let lines: Vec<String> = message
            .lines()
            .take(RUNNER_STACK_FRAME_CAP)
            .map(str::to_string)
            .collect();
        let shape = runner_stack_shape(&lines);
        if shape.shape != "all_redacted" {
            self.runner_embedded_stack_shape = Some(shape);
        }
    }

    /// The shape of a stack embedded inside a `(runner)` error record this pass, or
    /// `None` when none recognised frames. Read by `runner_stack_shape_for_exit` to
    /// prefer a real embedded stack over a tail-derived `all_redacted`.
    pub fn runner_embedded_stack_shape(&self) -> Option<RunnerStackShape> {
        self.runner_embedded_stack_shape.clone()
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
        // Class + syscall + errno are recorded together from the SAME line, so a
        // later None line never leaves the class from one line and the syscall
        // from another. Last non-None line wins, matching the class's existing
        // sticky semantics.
        let signature = classify_runner_fatal_signature(line);
        // Sticky crash evidence, set from THIS line before the last-wins overwrite
        // below can bury it under a later npm companion line. Never cleared.
        if signature.class.is_genuine_crash() {
            self.saw_genuine_crash_fatal = true;
        }
        if signature.class != RunnerFatalClass::None {
            self.runner_fatal_class = signature.class;
            self.runner_fatal_syscall = signature.syscall;
            self.runner_fatal_errno = signature.errno;
            // Assertion identity moves in lockstep with the class, parsed from
            // the SAME line and only for assertion classes. Cleared for a
            // non-assertion fatal line so the three can never leave a stale
            // assertion attached to a different class from a later line.
            match runner_assertion_for_class(signature.class, line) {
                Some(assertion) => {
                    self.runner_assert_source = Some(assertion.source);
                    self.runner_assert_line = assertion.line;
                    self.runner_assert_signature = Some(assertion.signature);
                }
                None => {
                    self.runner_assert_source = None;
                    self.runner_assert_line = None;
                    self.runner_assert_signature = None;
                }
            }
        }
        // Retain V8 heap-OOM evidence at the failure site (HQ-DESKTOP-55). This is
        // diagnostic-only: it never flips any alert/suppression flag and never
        // affects capture. Fed the SAME line as the classification above, so both
        // routes (which share this seam) inherit identical heap attribution.
        self.record_heap_oom_stderr_line(line, signature.class);
    }

    /// Single-pass, line-oriented V8 heap-OOM retention. Three transitions, in
    /// order: (a) update the last-wins GC candidate and true peak until frozen;
    /// (b) create the evidence on the first heap-OOM banner, freezing both values
    /// into it; (c) collect the bounded native-stack section that follows the
    /// banner.
    /// A V8 heap OOM aborts the process, so this state can never span a reset.
    fn record_heap_oom_stderr_line(&mut self, line: &str, class: RunnerFatalClass) {
        // (a) GC values — keep the existing last-wins candidate while tracking a
        // separate true used peak. Both become permanently frozen once the banner
        // is seen, so a post-banner GC-shaped line can never move either value.
        if self.heap_oom.is_none() {
            if let Some((used, total)) = parse_gc_heap_candidate(line) {
                let used_mb = round_mb(used);
                self.heap_gc_candidate = Some((used_mb, round_mb(total)));
                self.heap_gc_peak_used_mb = Some(
                    self.heap_gc_peak_used_mb
                        .map_or(used_mb, |peak| peak.max(used_mb)),
                );
            }
        }
        // (b) Banner — create the evidence on the first heap-OOM fatal line and
        // freeze the current GC candidate plus its true used peak.
        if class == RunnerFatalClass::HeapOom && self.heap_oom.is_none() {
            let lowered = line.to_ascii_lowercase();
            let banner = if lowered.contains("reached heap limit") {
                "reached_heap_limit"
            } else if lowered.contains("ineffective mark-compacts") {
                "ineffective_mark_compacts"
            } else {
                "other"
            };
            self.heap_oom = Some(HeapOomEvidence {
                banner,
                used_total_mb: self.heap_gc_candidate,
                peak_used_mb: self.heap_gc_peak_used_mb,
                frames: Vec::new(),
                frames_done: false,
            });
            // The banner line itself is never a native frame.
            return;
        }
        // (c) Frame capture — collect normalized native symbols after the banner.
        if let Some(evidence) = self.heap_oom.as_mut() {
            if evidence.frames_done {
                return;
            }
            if let Some(symbol) = parse_native_frame_symbol(line) {
                if evidence.frames.len() < HEAP_OOM_FRAME_CAP {
                    evidence.frames.push(symbol);
                }
            } else if line.trim().is_empty() {
                // Tolerate the blank lines V8 prints between the banner and frames.
            } else if evidence.frames.is_empty() {
                // Still seeking the first frame: tolerate the non-frame preamble
                // (e.g. the `----- Native stack trace -----` marker) before it.
            } else {
                // A non-blank non-frame line after the stack ends capture for good
                // (e.g. a `timeout: … dumped core` trailer or unrelated output).
                evidence.frames_done = true;
            }
        }
    }

    /// The V8 fatal banner retained this pass (`reached_heap_limit`,
    /// `ineffective_mark_compacts`, or `other`), or `None` when no heap-OOM banner
    /// was seen. A fixed constant, safe as a Sentry tag.
    pub fn runner_heap_oom_banner(&self) -> Option<&'static str> {
        self.heap_oom.as_ref().map(|evidence| evidence.banner)
    }

    /// Committed heap `(used, total)` MB for the retained heap OOM, or `None` when
    /// no GC line preceded the banner. Both-or-neither integers, never floats.
    pub fn runner_heap_used_total_mb(&self) -> Option<(u64, u64)> {
        self.heap_oom.as_ref().and_then(|evidence| evidence.used_total_mb)
    }

    /// Highest V8 GC heap-used MB before the retained heap-OOM banner, or `None`
    /// when no GC line preceded the banner. Unlike [`Self::runner_heap_used_total_mb`],
    /// this is a true maximum and backs the `runner_heap_peak_used_bucket` tag.
    pub fn runner_heap_peak_used_mb(&self) -> Option<u64> {
        self.heap_oom
            .as_ref()
            .and_then(|evidence| evidence.peak_used_mb)
    }

    /// Count of native-stack frames captured for the retained heap OOM (0 when the
    /// banner arrived with no frames), or `None` when no heap OOM was seen. A bare
    /// integer, capped at [`HEAP_OOM_FRAME_CAP`].
    pub fn runner_heap_oom_frame_count(&self) -> Option<u32> {
        self.heap_oom
            .as_ref()
            .map(|evidence| evidence.frames.len() as u32)
    }

    /// The class-scoped stack shape for the retained heap OOM, or `None` when no
    /// heap OOM was seen or no frame was captured (so the caller falls back to the
    /// generic tail shape byte-identically). The shape is the first
    /// [`RUNNER_STACK_FRAME_CAP`] frames mapped to fixed tokens; the signature is a
    /// digest of the FULL captured normalized-symbol list, so two stacks that
    /// differ only in the allocating frame hash differently while addresses, pids,
    /// and module suffixes — already stripped — keep it deterministic per build.
    pub fn runner_heap_oom_stack(&self) -> Option<RunnerStackShape> {
        let evidence = self.heap_oom.as_ref()?;
        if evidence.frames.is_empty() {
            return None;
        }
        Some(heap_oom_stack_shape(&evidence.frames))
    }

    /// The allow-listed libuv syscall identifier for the last recognised
    /// `LibuvFatalSyscall` line this pass, or `None`. Always a fixed constant
    /// selected in code — never a copied runner byte — so it is safe as a
    /// Sentry tag value.
    pub fn runner_fatal_syscall(&self) -> Option<&'static str> {
        self.runner_fatal_syscall
    }

    /// The integer errno parsed from that same line, or `None`.
    pub fn runner_fatal_errno(&self) -> Option<i64> {
        self.runner_fatal_errno
    }

    /// The allow-listed libuv source token for the last recognised assertion
    /// line this pass, or `None`. Always a fixed constant, safe as a Sentry tag.
    pub fn runner_assert_source(&self) -> Option<&'static str> {
        self.runner_assert_source
    }

    /// The integer source line for that same assertion, or `None`.
    pub fn runner_assert_line(&self) -> Option<i64> {
        self.runner_assert_line
    }

    /// The 16-hex SHA-256 prefix of that same assertion's expression, or `None`.
    /// A digest, never the expression text.
    pub fn runner_assert_signature(&self) -> Option<&str> {
        self.runner_assert_signature.as_deref()
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

/// Single source of truth for the runner-phase vocabulary shared by the manual
/// and watcher routes. `runner_phase_from_event` can only ever return one of the
/// event-derived tokens (`scan`/`push`/`pull`/`idle`/`unknown`); `pre_protocol`
/// is the never-observed default a route starts at before the runner emits any
/// protocol event, so "died before doing any work" is distinguishable from a
/// `Progress` with no/unrecognised direction (which stays `unknown`). The egress
/// validator's `runner_phase` arm and the desktop-alt `RunnerPhase` TS union must
/// enumerate exactly this set — the tri-source vocabulary test guards that.
pub const RUNNER_PHASE_VOCABULARY: &[&str] =
    &["scan", "push", "pull", "idle", "unknown", "pre_protocol"];

/// The never-observed runner phase: a route starts here and only leaves it once
/// the runner emits a protocol event. Kept as a named constant so both routes
/// and their defaults spell the sentinel identically.
pub const RUNNER_PHASE_PRE_PROTOCOL: &str = "pre_protocol";

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
///
/// The first block is the generic runtime-frame vocabulary matched by
/// [`runner_stack_shape`]; the trailing `heap_oom_*`/`v8_*`/`node_*`/`anon`
/// block is the class-scoped V8 heap-OOM vocabulary emitted by
/// [`RunTotals::runner_heap_oom_stack`]. The set must stay identical to
/// `hq_telemetry`'s copy (an egress-validator anti-drift parity test enforces
/// this), or a new token would be silently `[Filtered]` at send.
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
    // V8 heap-OOM native-frame vocabulary (HQ-DESKTOP-55). Every value is a
    // fixed constant selected in code from the frame's normalized symbol; a
    // symbol that matches none collapses to `anon`, never copied bytes.
    "node_oom_handler",
    "node_abort",
    "v8_report_oom",
    "v8_fatal_process_oom",
    "v8_heap_allocator",
    "v8_heap",
    "v8_factory",
    "v8_runtime",
    "v8_builtin",
    "v8_other",
    "node_native",
    "anon",
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

/// Hard cap on retained V8 heap-OOM native frames. Real captured sections are
/// 14–16 frames; the cap bounds a hostile or runaway stream without truncating
/// any genuine V8 OOM stack.
const HEAP_OOM_FRAME_CAP: usize = 32;

/// The fixed placeholder for a native frame with no symbol (an address-only
/// frame). Content-safe: it is emitted verbatim as a shape token and never
/// carries observed bytes. Also counted as a redacted frame.
const HEAP_OOM_ANON_FRAME: &str = "anon";

/// Round-half-away-from-zero MB. `f64::round` rounds halves away from zero
/// (47.5→48, 80.5→81, 47.4→47); the value is already bounded `0 <= v < 2^20` by
/// the GC parser, so the `as u64` cast never saturates or wraps.
fn round_mb(value: f64) -> u64 {
    value.round() as u64
}

/// Parse a V8 GC line's committed heap figures. V8 prints
/// `… <used> (<total>) -> <used> (<total>) MB, …`; the committed values are the
/// pair AFTER the last `-> `. Returns `(used, total)` in MB, or `None` unless the
/// strict `<f64> ( <f64> ) MB` shape holds with both finite and in `[0, 2^20)`,
/// so ordinary prose and a truncated line degrade to absent rather than wrong.
fn parse_gc_heap_candidate(line: &str) -> Option<(f64, f64)> {
    let (_, after) = line.rsplit_once("-> ")?;
    let after = after.trim_start();
    let used_end = after
        .find(|character: char| !(character.is_ascii_digit() || character == '.'))
        .unwrap_or(after.len());
    let used: f64 = after[..used_end].parse().ok()?;
    let rest = after[used_end..].trim_start();
    let rest = rest.strip_prefix('(')?;
    let close = rest.find(')')?;
    let total: f64 = rest[..close].trim().parse().ok()?;
    if !rest[close + 1..].trim_start().starts_with("MB") {
        return None;
    }
    let in_bounds = |value: f64| value.is_finite() && (0.0..1_048_576.0).contains(&value);
    (in_bounds(used) && in_bounds(total)).then_some((used, total))
}

/// Strip one trailing bracketed `[…]` suffix from a native frame symbol. V8/Node
/// print the owning module there, which on macOS can be a filesystem path — it
/// must never be hashed or emitted, so it is removed before the symbol is stored.
fn strip_trailing_bracketed(symbol: &str) -> &str {
    let trimmed = symbol.trim_end();
    if trimmed.ends_with(']') {
        if let Some(open) = trimmed.rfind('[') {
            return trimmed[..open].trim_end();
        }
    }
    trimmed
}

/// Extract the normalized symbol from a V8 native-stack frame line of the shape
/// `<ordinal>: 0x<hex> <symbol> [<module>]`, dropping the ordinal, the address,
/// and the bracketed module suffix. Returns `None` unless the line is a native
/// frame (1–3 digit ordinal, `:`, whitespace, then a `0x<hex>` address), so GC
/// lines, banners, and markers are rejected. An address-only frame (empty symbol)
/// normalizes to the fixed [`HEAP_OOM_ANON_FRAME`] placeholder.
fn parse_native_frame_symbol(line: &str) -> Option<String> {
    let (ordinal, rest) = line.trim().split_once(':')?;
    if ordinal.is_empty()
        || ordinal.len() > 3
        || !ordinal.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let rest = rest.trim_start();
    let (address, symbol_and_module) = match rest.split_once(char::is_whitespace) {
        Some((address, tail)) => (address, tail),
        None => (rest, ""),
    };
    let is_hex_address = address.len() > 2
        && (address.starts_with("0x") || address.starts_with("0X"))
        && address.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit);
    if !is_hex_address {
        return None;
    }
    let symbol = strip_trailing_bracketed(symbol_and_module.trim()).trim();
    Some(if symbol.is_empty() {
        HEAP_OOM_ANON_FRAME.to_string()
    } else {
        symbol.to_string()
    })
}

/// Map a normalized V8 native-frame symbol to a fixed shape token. First match
/// wins by substring containment (like `classify_runner_fatal_class`), most
/// specific first, and the return is always one of the appended
/// [`RUNNER_STACK_TOKENS`] constants — a symbol matching none collapses to `anon`,
/// so no observed byte can escape through this token.
fn heap_oom_frame_token(symbol: &str) -> &'static str {
    if symbol.contains("OOMErrorHandler") {
        "node_oom_handler"
    } else if symbol.contains("node::Abort") || symbol.contains("OnFatalError") {
        "node_abort"
    } else if symbol.contains("ReportOOMFailure") {
        "v8_report_oom"
    } else if symbol.contains("FatalProcessOutOfMemory") {
        "v8_fatal_process_oom"
    } else if symbol.contains("HeapAllocator") {
        // Checked before the broader `v8::internal::Heap` marker, which it
        // contains as a substring.
        "v8_heap_allocator"
    } else if symbol.contains("v8::internal::Heap") {
        "v8_heap"
    } else if symbol.contains("Factory") {
        "v8_factory"
    } else if symbol.contains("Runtime_") {
        "v8_runtime"
    } else if symbol.contains("Builtins_") {
        "v8_builtin"
    } else if symbol.contains("v8::") {
        "v8_other"
    } else if symbol.contains("node::") {
        "node_native"
    } else {
        HEAP_OOM_ANON_FRAME
    }
}

/// Build the class-scoped stack shape from a non-empty captured V8 heap-OOM frame
/// list. The `shape` is the first [`RUNNER_STACK_FRAME_CAP`] frames' fixed tokens
/// (≤ 8 — the hq-telemetry shape validator's hard cap), `depth` and
/// `redacted_frames` keep the generic path's shape-scoped semantics (token count
/// and `anon` count within those 8), and the `signature` digests the FULL
/// normalized-symbol list so the allocating frame — which sits past frame 8 —
/// still discriminates. The symbols are never emitted; only the digest is.
fn heap_oom_stack_shape(frames: &[String]) -> RunnerStackShape {
    let shape_tokens: Vec<&'static str> = frames
        .iter()
        .take(RUNNER_STACK_FRAME_CAP)
        .map(|symbol| heap_oom_frame_token(symbol))
        .collect();
    let depth = shape_tokens.len() as u8;
    let redacted_frames = shape_tokens
        .iter()
        .filter(|token| **token == HEAP_OOM_ANON_FRAME)
        .count() as u8;
    let shape = shape_tokens.join(">");
    let digest = format!("{:x}", Sha256::digest(frames.join("\n").as_bytes()));
    RunnerStackShape {
        shape,
        depth,
        redacted_frames,
        signature: digest[..16].to_string(),
    }
}

/// Choose the exit-time stack shape both routes report: the class-scoped
/// heap-OOM shape when a heap-OOM native stack was retained this pass, else the
/// generic tail shape byte-identically. Reading from the shared `RunTotals` keeps
/// the manual and watcher routes attribute-identical.
pub fn runner_stack_shape_for_exit(totals: &RunTotals, tail: &[String]) -> RunnerStackShape {
    // A retained heap-OOM native stack is the most specific evidence and wins.
    if let Some(heap) = totals.runner_heap_oom_stack() {
        return heap;
    }
    let tail_shape = runner_stack_shape(tail);
    // The stderr TAIL is authoritative whenever it recognised any frame. But when
    // the tail was a flood of ndjson error records (`all_redacted`) AND a `(runner)`
    // error record embedded a shape-able err.stack in its MESSAGE — the frames the
    // tail axis structurally cannot see — prefer that embedded shape (HQ-DESKTOP-5M).
    // `runner_stack_input` still reports what the TAIL was, so the two axes stay
    // independently readable. Keeps both seams symmetric: they read one shared source.
    if tail_shape.shape == "all_redacted" {
        if let Some(embedded) = totals.runner_embedded_stack_shape() {
            return embedded;
        }
    }
    tail_shape
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
    // Filesystem errno classes (HQ-DESKTOP-4T r2). Added ONLY as new variants —
    // no existing variant is renamed, re-mapped, or re-ordered — so a rename
    // fault that previously collapsed to OTHER now reports a real class while the
    // op axis keeps reporting `rename`. Placed before the coarse
    // network/auth/other buckets so the classifier's precedence prefers a
    // specific errno class, matching the enum tie-break order.
    Enoent,
    Eexist,
    Enotempty,
    Exdev,
    Network,
    Auth,
    Other,
}

impl RunnerErrorClass {
    /// Every variant, so content-safety tests can enumerate the emitter's own
    /// token set instead of a hand-copied list.
    pub const ALL: [RunnerErrorClass; 11] = [
        Self::Eperm,
        Self::Eacces,
        Self::Enospc,
        Self::Ebusy,
        Self::Enoent,
        Self::Eexist,
        Self::Enotempty,
        Self::Exdev,
        Self::Network,
        Self::Auth,
        Self::Other,
    ];

    fn tag_name(self) -> &'static str {
        match self {
            Self::Eperm => "EPERM",
            Self::Eacces => "EACCES",
            Self::Enospc => "ENOSPC",
            Self::Ebusy => "EBUSY",
            Self::Enoent => "ENOENT",
            Self::Eexist => "EEXIST",
            Self::Enotempty => "ENOTEMPTY",
            Self::Exdev => "EXDEV",
            Self::Network => "NETWORK",
            Self::Auth => "AUTH",
            Self::Other => "OTHER",
        }
    }

    // `pub` so the watcher-seam validator (commands/daemon.rs) can derive its
    // accepted class-token set from `RunnerErrorClass::ALL` instead of a
    // hand-written allow-list that silently drifts behind the enum — the r2
    // regression where enoent/eexist/enotempty/exdev degraded to "none".
    pub fn fingerprint_token(self) -> &'static str {
        match self {
            Self::Eperm => "eperm",
            Self::Eacces => "eacces",
            Self::Enospc => "enospc",
            Self::Ebusy => "ebusy",
            Self::Enoent => "enoent",
            Self::Eexist => "eexist",
            Self::Enotempty => "enotempty",
            Self::Exdev => "exdev",
            Self::Network => "network",
            Self::Auth => "auth",
            Self::Other => "other",
        }
    }

    /// Breadcrumb-only rendering of the class. Deliberately spells the auth class
    /// `identity`, NOT `auth`: Sentry's default `@password:filter` scrubber
    /// deletes any breadcrumb containing an auth-ish token, which destroyed the
    /// single most diagnostic HQ-DESKTOP-4T breadcrumb. `tag_name()` and
    /// `fingerprint_token()` keep `AUTH`/`auth` so grouping and history survive.
    pub fn breadcrumb_token(self) -> &'static str {
        match self {
            Self::Eperm => "eperm",
            Self::Eacces => "eacces",
            Self::Enospc => "enospc",
            Self::Ebusy => "ebusy",
            Self::Enoent => "enoent",
            Self::Eexist => "eexist",
            Self::Enotempty => "enotempty",
            Self::Exdev => "exdev",
            Self::Network => "network",
            Self::Auth => "identity",
            Self::Other => "other",
        }
    }
}

/// True when `haystack` (already lowercased) contains `errno` as a bounded token
/// — bordered by the start/end of the string or a non-alphanumeric byte on each
/// side. `describeError` renders a Node errno as its own token (`EEXIST:`,
/// `code=EEXIST`, ` EEXIST `), so a bounded match still catches every real
/// rendering while refusing an errno spelled INSIDE an ordinary word — e.g.
/// `eexist` inside `preexisting`, which a bare `contains` would misclassify.
fn message_contains_errno_token(haystack_lower: &str, errno: &str) -> bool {
    let bytes = haystack_lower.as_bytes();
    let mut search_from = 0;
    while let Some(offset) = haystack_lower[search_from..].find(errno) {
        let index = search_from + offset;
        let before_ok = index == 0 || !bytes[index - 1].is_ascii_alphanumeric();
        let after = index + errno.len();
        let after_ok = after >= bytes.len() || !bytes[after].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        search_from = index + 1;
    }
    false
}

/// Bridge the CAUSE axis to the CLASS axis: when the closed cause vocabulary has
/// positively NAMED a fault, that name is a stronger classifier than the coarse
/// keyword matcher below, which is blind to the named-cause vocabulary and
/// collapses any message it does not recognise to `Other`. That blindness is the
/// HQ-DESKTOP-4T catch-all: a `VaultPermissionDeniedError` the cause axis named
/// `vault_permission_denied` still classified `Other` (its text carries none of
/// eperm/eacces/enospc/ebusy, no transient-network marker, and none of
/// auth|unauthorized|forbidden|cognito|token), so every such exit-2 landed on the
/// one `["sync","runner-termination","exit:2","other"]` fingerprint.
///
/// EXHAUSTIVE over every `RunnerErrorCause` with NO wildcard arm, so adding a
/// future cause is a compile error here rather than a silent fall-through. A
/// variant maps to `Some(class)` ONLY when the class is unambiguous from the
/// name — an authorization/identity failure to `Auth`, a network/DNS/connection
/// transport fault to `Network`, and a filesystem errno to its matching errno
/// class. Every other variant returns an explicit `None`, meaning "the keyword
/// fallback is still the best answer", so an unnamed or class-ambiguous message
/// is classified exactly as it is today.
fn class_for_named_cause(cause: RunnerErrorCause) -> Option<RunnerErrorClass> {
    match cause {
        // ── Authorization / identity failures → Auth ─────────────────────────
        // The recurrence family: a permission/authorization denial the keyword
        // matcher misses because its text carries no auth marker. Naming these
        // here is the fix — `vault_permission_denied` now classes AUTH.
        RunnerErrorCause::EntityPermission
        | RunnerErrorCause::VaultPermissionDenied
        | RunnerErrorCause::VendDenied
        | RunnerErrorCause::AccessDenied => Some(RunnerErrorClass::Auth),
        // Identity/credential failures. The keyword matcher ALREADY classes these
        // AUTH (their messages carry auth/cognito/token), so mapping them is
        // consistent — and it keeps the class correct if a future rendering drops
        // the keyword the matcher happens to look for.
        RunnerErrorCause::VaultIdentity
        | RunnerErrorCause::CognitoIdentity
        | RunnerErrorCause::CognitoIdentityRefresh
        | RunnerErrorCause::ExpiredIdentity
        | RunnerErrorCause::InvalidIdentity => Some(RunnerErrorClass::Auth),
        // ── Network / DNS / connection transport → Network ───────────────────
        // Every transient-network errno `is_transient_network_error` already
        // recognises, PLUS ENOTFOUND (a getaddrinfo DNS failure) which it omits —
        // a definitive network fault the keyword matcher otherwise collapses to
        // Other.
        RunnerErrorCause::Econnreset
        | RunnerErrorCause::Econnrefused
        | RunnerErrorCause::Etimedout
        | RunnerErrorCause::Epipe
        | RunnerErrorCause::EaiAgain
        | RunnerErrorCause::Enetdown
        | RunnerErrorCause::Enetunreach
        | RunnerErrorCause::Ehostunreach
        | RunnerErrorCause::Enotfound => Some(RunnerErrorClass::Network),
        // ── Filesystem errno causes → their matching errno class ─────────────
        // The class axis has exactly these eight errno classes; a cause naming one
        // agrees with the keyword matcher on the same message.
        RunnerErrorCause::Eperm => Some(RunnerErrorClass::Eperm),
        RunnerErrorCause::Eacces => Some(RunnerErrorClass::Eacces),
        RunnerErrorCause::Enospc => Some(RunnerErrorClass::Enospc),
        RunnerErrorCause::Ebusy => Some(RunnerErrorClass::Ebusy),
        RunnerErrorCause::Enoent => Some(RunnerErrorClass::Enoent),
        RunnerErrorCause::Eexist => Some(RunnerErrorClass::Eexist),
        RunnerErrorCause::Enotempty => Some(RunnerErrorClass::Enotempty),
        RunnerErrorCause::Exdev => Some(RunnerErrorClass::Exdev),
        // ── Keyword fallback stays authoritative (explicit None) ─────────────
        // hq-cloud sync-protocol identities with no class analogue …
        RunnerErrorCause::EntityNotFound
        | RunnerErrorCause::EntityResolution
        | RunnerErrorCause::SourceNotFound
        | RunnerErrorCause::OperationLocked
        | RunnerErrorCause::OperationLockUnwritable
        | RunnerErrorCause::ScopeShrinkBlocked
        | RunnerErrorCause::ScopeShrinkLargePrune
        | RunnerErrorCause::DeltaGap
        | RunnerErrorCause::MultipartSourceChanged
        | RunnerErrorCause::MultipartAbort
        | RunnerErrorCause::RealtimeConflict
        | RunnerErrorCause::RealtimeEnrollmentUnavailable
        | RunnerErrorCause::SyncMutationNotEnrolled
        | RunnerErrorCause::UnreachablePushPaths
        | RunnerErrorCause::ServerOwnedPushPaths
        | RunnerErrorCause::PushEventDecode
        | RunnerErrorCause::LocalSnapshotChanged
        | RunnerErrorCause::RescuePathChanged
        | RunnerErrorCause::CursorRetired
        | RunnerErrorCause::BaseVersionUnavailable
        | RunnerErrorCause::DurableApply
        | RunnerErrorCause::DurableApplyRecovery
        | RunnerErrorCause::JournalCheckpoint
        | RunnerErrorCause::PrematureJournalEntry
        | RunnerErrorCause::SnapshotClient
        | RunnerErrorCause::StateStoreCorruption
        | RunnerErrorCause::StateStoreLock
        | RunnerErrorCause::StateStoreReducer
        | RunnerErrorCause::VaultClient
        | RunnerErrorCause::VaultConflict
        | RunnerErrorCause::VaultNotFound
        | RunnerErrorCause::RateLimited
        | RunnerErrorCause::PresignPreconditionMissing
        | RunnerErrorCause::OutpostHttp
        | RunnerErrorCause::TombstoneFetch
        | RunnerErrorCause::UnregisteredCompanySkill
        | RunnerErrorCause::RefreshLockTimeout
        | RunnerErrorCause::DanglingSymlinkParent
        | RunnerErrorCause::WindowsSymlinkPrivilege
        | RunnerErrorCause::ChildProcessSyncWorker
        // … the ~6.16.0 pin's additions — none has an unambiguous class
        // analogue (realtime-lane outage and Windows rename-block fall back to
        // the keyword matcher; the two outposts terminal classes are
        // CLI-surface errors that never appear in runner output) …
        | RunnerErrorCause::RealtimeUnavailable
        | RunnerErrorCause::WindowsRenameBlocked
        | RunnerErrorCause::SessionManagerPluginLaunch
        | RunnerErrorCause::TerminalSessionTimeout
        // … AWS S3/STS names with no class analogue …
        | RunnerErrorCause::NoSuchKey
        | RunnerErrorCause::NoSuchBucket
        | RunnerErrorCause::SlowDown
        | RunnerErrorCause::InternalError
        | RunnerErrorCause::RequestTimeout
        | RunnerErrorCause::UnknownError
        // … ECMAScript / Node built-in error identities …
        | RunnerErrorCause::RangeError
        | RunnerErrorCause::TypeError
        | RunnerErrorCause::SyntaxError
        | RunnerErrorCause::ReferenceError
        | RunnerErrorCause::EvalError
        | RunnerErrorCause::UriError
        | RunnerErrorCause::AggregateError
        | RunnerErrorCause::AbortError
        | RunnerErrorCause::SystemError
        // … non-fs, non-transport errnos with no class analogue …
        | RunnerErrorCause::Eisdir
        | RunnerErrorCause::Enotdir
        | RunnerErrorCause::Eloop
        | RunnerErrorCause::Enametoolong
        | RunnerErrorCause::Emfile
        | RunnerErrorCause::Enfile
        | RunnerErrorCause::Erofs
        | RunnerErrorCause::Eio
        | RunnerErrorCause::Eagain
        | RunnerErrorCause::Einval
        // … and the residual unknowns (never a nearest guess) …
        | RunnerErrorCause::UnknownNamed
        | RunnerErrorCause::UnknownUnnamed => None,
    }
}

/// Map an untrusted runner error message to a fixed telemetry class. This
/// function deliberately returns no message text, so its output is safe to
/// attach to Sentry as a tag.
pub fn classify_runner_error_class(message: &str) -> RunnerErrorClass {
    // A positively-named cause is a stronger signal than the coarse keyword
    // matcher, which is blind to the cause vocabulary. Consult the bridge first;
    // it returns `Some` only for a cause it can unambiguously class, so an unnamed
    // or class-ambiguous message falls through to the keyword matcher below,
    // classified exactly as it is today.
    if let Some(class) = class_for_named_cause(classify_runner_error_cause(message)) {
        return class;
    }
    let msg = message.to_lowercase();
    if msg.contains("eperm") {
        RunnerErrorClass::Eperm
    } else if msg.contains("eacces") {
        RunnerErrorClass::Eacces
    } else if msg.contains("enospc") {
        RunnerErrorClass::Enospc
    } else if msg.contains("ebusy") {
        RunnerErrorClass::Ebusy
    } else if message_contains_errno_token(&msg, "enoent") {
        RunnerErrorClass::Enoent
    } else if message_contains_errno_token(&msg, "eexist") {
        RunnerErrorClass::Eexist
    } else if message_contains_errno_token(&msg, "enotempty") {
        RunnerErrorClass::Enotempty
    } else if message_contains_errno_token(&msg, "exdev") {
        RunnerErrorClass::Exdev
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
    /// libuv's `uv_fatal_error` output — shape `<syscall>: (<errno>) <message>`
    /// (e.g. `ReadDirectoryChangesW: (5) Access is denied.`). The leading token
    /// must be an allow-listed libuv/Win32 syscall identifier plus an integer
    /// errno; anything else stays `None`.
    LibuvFatalSyscall,
    NodeCheckAbort,
    NodeFatal,
    HeapOom,
    RustPanic,
    ExecPermissionDenied,
    ExecNotFound,
    NodeTooOld,
    /// The runner terminated because the machine's disk is full (`ENOSPC`). An
    /// expected local-machine condition the user fixes by freeing space, never a
    /// product defect — mirroring `hq_cli_update`'s `ExpectedDiskFull` for the
    /// CLI-update lane and `run_cli_provision`'s `disk-full` classification. The
    /// causal disk-full attribution deliberately outranks the `npm_install_relay`
    /// messenger in `classify_runner_fatal_class` (its arm runs first). The token
    /// is a fixed constant, never derived from observed bytes.
    DiskFull,
    /// npm relayed a failing lifecycle/install status while printing only its own
    /// `npm error …` / `npm ERR! …` lines, with no shell not-found/permission
    /// marker. Attribution for the NEXT occurrence of an npm-shaped fast-fail —
    /// e.g. the still-unattributed exit-190 leg (HQ-DESKTOP-51) — never a causal
    /// claim. The token is a fixed constant, never derived from observed bytes.
    NpmInstallRelay,
    #[default]
    None,
}

impl RunnerFatalClass {
    /// Every variant, so content-safety tests can enumerate the emitter's own
    /// fatal-class token set instead of a hand-copied list.
    pub const ALL: [RunnerFatalClass; 12] = [
        Self::LibuvAssert,
        Self::LibuvFatalSyscall,
        Self::NodeCheckAbort,
        Self::NodeFatal,
        Self::HeapOom,
        Self::RustPanic,
        Self::ExecPermissionDenied,
        Self::ExecNotFound,
        Self::NodeTooOld,
        Self::DiskFull,
        Self::NpmInstallRelay,
        Self::None,
    ];

    /// Fixed vocabulary safe for Sentry tags and breadcrumbs.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LibuvAssert => "libuv_assert",
            Self::LibuvFatalSyscall => "libuv_fatal_syscall",
            Self::NodeCheckAbort => "node_check_abort",
            Self::NodeFatal => "node_fatal",
            Self::HeapOom => "heap_oom",
            Self::RustPanic => "rust_panic",
            Self::ExecPermissionDenied => "exec_permission_denied",
            Self::ExecNotFound => "exec_not_found",
            Self::NodeTooOld => "node_too_old",
            Self::DiskFull => "disk_full",
            Self::NpmInstallRelay => "npm_install_relay",
            Self::None => "none",
        }
    }

    pub fn seen(self) -> bool {
        self != Self::None
    }

    /// Classes that prove the runner genuinely crashed. A disk-exhaustion exit
    /// must never suppress an alert when one of these co-occurs in the same
    /// stderr stream, so the disk-full disposition gate excludes them. Kept in
    /// lockstep with the crash arms of [`classify_runner_fatal_class`].
    pub fn is_genuine_crash(self) -> bool {
        matches!(
            self,
            Self::LibuvAssert
                | Self::LibuvFatalSyscall
                | Self::NodeCheckAbort
                | Self::NodeFatal
                | Self::HeapOom
                | Self::RustPanic
        )
    }
}

/// The fatal class plus, for `LibuvFatalSyscall`, the allow-listed syscall
/// identifier and integer errno parsed from the same line. Both extras are
/// `None` for every other class. Content-safe by construction: `syscall` is
/// always a fixed allow-listed constant (never copied runner bytes) and `errno`
/// is a bare integer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RunnerFatalSignature {
    pub class: RunnerFatalClass,
    pub syscall: Option<&'static str>,
    pub errno: Option<i64>,
}

/// Fixed allow-list of libuv/Win32 syscall identifiers that libuv's
/// `uv_fatal_error` names in its `<syscall>: (<errno>) <message>` output. Only
/// these canonical spellings may ever leave the process as a
/// `runner_fatal_syscall` tag; an identifier outside the list keeps the line
/// unclassified (`None`) and, defensively, renders as the constant `other`
/// rather than the observed word.
pub const LIBUV_FATAL_SYSCALLS: &[&str] = &[
    "ReadDirectoryChangesW",
    "CreateFileW",
    "CreateIoCompletionPort",
    "GetQueuedCompletionStatus",
    "PostQueuedCompletionStatus",
    "CancelIo",
    "CancelIoEx",
    "WSAStartup",
    "WSARecv",
    "WSASend",
    "uv_fs_event",
    "uv_pipe",
    "uv_tcp",
    "uv_loop_init",
    "uv_thread_create",
    "uv_async_send",
    "uv_poll_start",
    "uv_spawn",
    "kevent",
    "epoll_ctl",
    "inotify_init",
    "inotify_add_watch",
];

/// Canonicalise a candidate leading token to its allow-listed spelling, or
/// `None` when it is not a recognised libuv/Win32 syscall identifier. The
/// comparison is ASCII-case-insensitive but always returns the fixed constant,
/// never the observed bytes, so no runner text can escape through this token.
fn libuv_fatal_syscall_token(candidate: &str) -> Option<&'static str> {
    LIBUV_FATAL_SYSCALLS
        .iter()
        .find(|known| candidate.eq_ignore_ascii_case(known))
        .copied()
}

/// Parse libuv's `uv_fatal_error` line shape `<syscall>: (<errno>) <message>`.
/// Returns the leading identifier mapped to its allow-listed canonical spelling
/// (`"other"` when the shape matched but the identifier is unknown) and the
/// parenthesised integer errno. Returns `None` unless the leading token is a
/// single bare identifier and the errno is an integer — so ordinary prose,
/// drive-letter paths, and messages that merely contain a colon and a number
/// are rejected.
fn parse_libuv_fatal_syscall(line: &str) -> Option<(&'static str, i64)> {
    let line = line.trim();
    let (head, rest) = line.split_once(':')?;
    let head = head.trim();
    // libuv names exactly one syscall here, never a phrase or a path. Requiring
    // `[A-Za-z0-9_]+` keeps "Error: (5) x", "C:\\path", and "12:34" out.
    if head.is_empty() || !head.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return None;
    }
    let inner = rest.trim_start().strip_prefix('(')?;
    let close = inner.find(')')?;
    let errno: i64 = inner[..close].trim().parse().ok()?;
    let token = libuv_fatal_syscall_token(head).unwrap_or("other");
    Some((token, errno))
}

/// True only for a libuv `uv_fatal_error` line whose leading token is an
/// allow-listed syscall identifier and whose errno is an integer. An unknown
/// leading identifier (shape matches but token is `other`) is deliberately not
/// enough — the line stays `None`.
fn is_libuv_fatal_syscall_line(line: &str) -> bool {
    matches!(parse_libuv_fatal_syscall(line), Some((token, _)) if token != "other")
}

/// Fixed allow-list of source tokens a runner assertion `file` field may resolve
/// to. `other` is the sentinel for any file that is not one of the recognised
/// libuv sources — the same convention `runner_fatal_syscall` uses for an
/// unknown syscall identifier.
pub const RUNNER_ASSERT_SOURCES: &[&str] =
    &["libuv_win_async", "libuv_unix_core", "libuv_handle", "other"];

/// Content-safe identity of a libuv/Node runtime assertion. Every field is
/// derived, never copied: `source` is one allow-listed constant, `line` is a
/// bare integer, and `signature` is a SHA-256 prefix of the asserted expression.
/// The expression text, the file path, a username, and a company slug can never
/// leave the process through any of the three.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerAssertion {
    pub source: &'static str,
    pub line: Option<i64>,
    pub signature: String,
}

/// Map an assertion `file` field to an allow-listed libuv source token, reusing
/// the runtime frame table's libuv path markers. Only libuv source tokens are
/// meaningful for an assertion, so anything else is the `other` sentinel. The
/// return is always a fixed constant selected in code, never the observed bytes.
fn runner_assert_source_token(file: &str) -> &'static str {
    let lowered = file.to_ascii_lowercase();
    for (marker, token) in RUNTIME_FRAME_TABLE {
        if matches!(*token, "libuv_win_async" | "libuv_unix_core" | "libuv_handle")
            && lowered.contains(&marker.to_ascii_lowercase())
        {
            return token;
        }
    }
    "other"
}

/// Normalise an asserted expression before hashing: trim and collapse ASCII
/// whitespace runs to a single space. Only the digest leaves the process, so the
/// normalisation only needs to be deterministic (equal expressions hash equal,
/// different ones almost never collide), not reversible.
fn normalize_assertion_expr(expr: &str) -> String {
    expr.split_ascii_whitespace().collect::<Vec<_>>().join(" ")
}

/// Case-insensitive `split_once`. libuv/Node print the assertion field labels in
/// lower case, but matching case-insensitively keeps a future spelling variant
/// from silently dropping the source and line.
fn split_once_ci<'a>(haystack: &'a str, needle: &str) -> Option<(&'a str, &'a str)> {
    let lowered_haystack = haystack.to_ascii_lowercase();
    let lowered_needle = needle.to_ascii_lowercase();
    let index = lowered_haystack.find(&lowered_needle)?;
    Some((&haystack[..index], &haystack[index + needle.len()..]))
}

/// Parse the leading run of ASCII digits as an integer, ignoring any trailing
/// bytes (e.g. `76: C:\path` -> 76 with the path discarded). `None` when no
/// leading digit is present, so a malformed line degrades to absent rather than
/// to a wrong integer.
fn parse_leading_i64(candidate: &str) -> Option<i64> {
    let digits: String = candidate
        .trim_start()
        .bytes()
        .take_while(u8::is_ascii_digit)
        .map(char::from)
        .collect();
    digits.parse::<i64>().ok()
}

/// Parse a libuv/Node assertion line into content-safe identity. Recognises the
/// canonical `Assertion failed: <expr>, file <path>, line <N>` shape libuv and
/// Node print, where each part is a compile-time constant of the runtime rather
/// than user input. Emits only an allow-listed token, a bare integer, and a
/// digest, so no observed byte can escape. Returns `None` when the line carries
/// no assertion marker or the expression is empty.
pub fn parse_runner_assertion(line: &str) -> Option<RunnerAssertion> {
    const MARKER: &str = "assertion failed:";
    let (_, after_marker) = split_once_ci(line, MARKER)?;
    // The expression runs to the first `, file ` boundary, or to end of line for
    // shapes (e.g. Node CHECK aborts) that omit the file/line trailer.
    let (expr_raw, file_tail) = match split_once_ci(after_marker, ", file ") {
        Some((expr, tail)) => (expr, Some(tail)),
        None => (after_marker, None),
    };
    let normalized = normalize_assertion_expr(expr_raw);
    if normalized.is_empty() {
        return None;
    }
    let digest = format!("{:x}", Sha256::digest(normalized.as_bytes()));
    let signature = digest[..16].to_string();

    let (source, line_no) = match file_tail {
        Some(tail) => match split_once_ci(tail, ", line ") {
            Some((path, after_line)) => {
                (runner_assert_source_token(path), parse_leading_i64(after_line))
            }
            None => (runner_assert_source_token(tail), None),
        },
        None => ("other", None),
    };

    Some(RunnerAssertion {
        source,
        line: line_no,
        signature,
    })
}

/// Assertion identity for a fatal line, present only for the assertion fatal
/// classes (`LibuvAssert` / `NodeCheckAbort`). Every other class returns `None`,
/// so a non-assertion line never carries assertion fields.
pub fn runner_assertion_for_class(class: RunnerFatalClass, line: &str) -> Option<RunnerAssertion> {
    matches!(
        class,
        RunnerFatalClass::LibuvAssert | RunnerFatalClass::NodeCheckAbort
    )
    .then(|| parse_runner_assertion(line))
    .flatten()
}

/// True when an already-lowercased message carries an UNAMBIGUOUS libuv marker.
/// Widened from the single `src\win\async.c` marker to the libuv vendor path
/// (`deps/uv/`), which Node's bundled libuv prints for any of its sources
/// (`fs-event.c`, `pipe.c`, `core.c`, …), so those assertions still classify as
/// `LibuvAssert`. Generic `src\win\` / `src/unix/` fragments are deliberately
/// NOT accepted on their own: other trees are organised the same way, so an
/// assertion from Node, a dependency, or a native addon must not be mislabeled
/// libuv. Kept conjoined with an `assertion failed` marker by the caller.
fn is_libuv_source_marker(lowercased: &str) -> bool {
    lowercased.contains("libuv")
        || lowercased.contains("uv_handle")
        || lowercased.contains(r"deps\uv\")
        || lowercased.contains("deps/uv/")
        || lowercased.contains(r"src\win\async.c")
        || lowercased.contains("src/win/async.c")
}

/// Classify untrusted runner stderr without retaining any of it, and, for a
/// libuv `uv_fatal_error` line, also recover the allow-listed syscall and
/// integer errno. The libuv-assert match deliberately requires both an
/// assertion marker and a libuv-specific source/handle marker so ordinary
/// application assertions remain `none`.
pub fn classify_runner_fatal_signature(line: &str) -> RunnerFatalSignature {
    let class = classify_runner_fatal_class(line);
    if class == RunnerFatalClass::LibuvFatalSyscall {
        if let Some((syscall, errno)) = parse_libuv_fatal_syscall(line) {
            return RunnerFatalSignature {
                class,
                syscall: Some(syscall),
                errno: Some(errno),
            };
        }
    }
    RunnerFatalSignature {
        class,
        syscall: None,
        errno: None,
    }
}

/// Classify untrusted runner stderr without retaining any of it. The libuv
/// match deliberately requires both an assertion marker and a libuv-specific
/// source/handle marker so ordinary application assertions remain `none`. The
/// libuv-fatal-syscall arm is intentionally last so no line that a prior arm
/// already classifies can change class.
pub fn classify_runner_fatal_class(line: &str) -> RunnerFatalClass {
    let left_trimmed = line.trim_start();
    let msg = line.to_ascii_lowercase();
    if is_node_too_old_signature(&msg) {
        RunnerFatalClass::NodeTooOld
    } else if msg.contains("assertion failed") && is_libuv_source_marker(&msg) {
        RunnerFatalClass::LibuvAssert
    } else if left_trimmed.starts_with('#') && msg.contains("assertion failed:") {
        RunnerFatalClass::NodeCheckAbort
    } else if msg.contains("javascript heap out of memory") {
        RunnerFatalClass::HeapOom
    } else if msg.contains("panicked at") {
        RunnerFatalClass::RustPanic
    } else if ["fatal error", "uncaught exception", "unhandledrejection"]
        .iter()
        .any(|marker| msg.contains(marker))
    {
        RunnerFatalClass::NodeFatal
    } else if crate::hq_cli_update::is_disk_exhaustion_failure(line) {
        // Disk exhaustion (ENOSPC) is the causal condition, evaluated BEFORE the
        // npm-relay arm so an `npm error code ENOSPC` line — and the hq-cloud
        // `ENOSPC: no space left on device` protocol error — is attributed to the
        // full disk rather than masked as `npm_install_relay`. Placed AFTER every
        // genuine-crash arm above so a real crash whose text merely mentions
        // ENOSPC keeps its crash class. Delegates to the crate's single
        // disk-exhaustion vocabulary (which excludes npm lifecycle failures) so
        // the sync, CLI-update, and provisioning lanes can never disagree. The RAW
        // `line` is passed because the delegate keys on npm's own uppercase
        // `ENOSPC` code.
        RunnerFatalClass::DiskFull
    } else if is_npm_error_line(&msg) {
        // npm's OWN line prefix, evaluated BEFORE the shell-exec arms so an
        // `npm error enoent ENOENT: no such file … /.npm/_npx/…` line is
        // attributed to the npm relay rather than mislabeled exec_not_found by
        // the `/.npm/_npx/` marker in is_runner_exec_shell_failure.
        RunnerFatalClass::NpmInstallRelay
    } else if is_runner_exec_shell_failure(&msg, "permission denied") {
        RunnerFatalClass::ExecPermissionDenied
    } else if is_runner_exec_shell_failure(&msg, "no such file or directory")
        || is_runner_exec_shell_failure(&msg, "command not found")
    {
        RunnerFatalClass::ExecNotFound
    } else if is_libuv_fatal_syscall_line(line) {
        RunnerFatalClass::LibuvFatalSyscall
    } else {
        RunnerFatalClass::None
    }
}

/// npm prints its own diagnostics with a stable `npm error ` (npm ≥ 9) or
/// `npm ERR! ` (npm ≤ 8) line prefix. Keying strictly on that own-prefix keeps
/// npm-relayed lifecycle failures — which can themselves carry an ENOENT under
/// `_npx` — out of the shell-exec classes. `message` is already lowercased; the
/// source line stays local and no bytes are copied.
fn is_npm_error_line(message: &str) -> bool {
    let trimmed = message.trim_start();
    trimmed.starts_with("npm error ") || trimmed.starts_with("npm err! ")
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
    enoent: u32,
    eexist: u32,
    enotempty: u32,
    exdev: u32,
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
            RunnerErrorClass::Enoent => &mut self.enoent,
            RunnerErrorClass::Eexist => &mut self.eexist,
            RunnerErrorClass::Enotempty => &mut self.enotempty,
            RunnerErrorClass::Exdev => &mut self.exdev,
            RunnerErrorClass::Network => &mut self.network,
            RunnerErrorClass::Auth => &mut self.auth,
            RunnerErrorClass::Other => &mut self.other,
        };
        *count = count.saturating_add(1);
    }

    /// True when the only runner error class recorded this pass was disk
    /// exhaustion (`ENOSPC`) — at least one ENOSPC and zero of every other class.
    /// This is the robust, last-wins-immune signal that a terminal exit was
    /// caused purely by a full disk: unlike the retained `runner_fatal_class`,
    /// which an npm companion line can overwrite, the rollup counts every parsed
    /// error record.
    pub fn is_exclusively_disk_full(&self) -> bool {
        self.enospc > 0 && !self.has_non_disk_full_error()
    }

    /// True when at least one filesystem-permission error (`EPERM`/`EACCES`) was
    /// recorded this pass. The client-health reporter (US-002) maps this to the
    /// closed `PERMISSION_DENIED` reason code — a class token, never a path.
    pub fn has_permission_error(&self) -> bool {
        self.eperm > 0 || self.eacces > 0
    }

    /// True when at least one runner error of a class OTHER than disk exhaustion
    /// was recorded this pass. The disk-full disposition gate requires this to be
    /// false, so a mixed rollup (e.g. `EPERM:1,ENOSPC:1`) never suppresses.
    pub fn has_non_disk_full_error(&self) -> bool {
        self.eperm > 0
            || self.eacces > 0
            || self.ebusy > 0
            || self.enoent > 0
            || self.eexist > 0
            || self.enotempty > 0
            || self.exdev > 0
            || self.network > 0
            || self.auth > 0
            || self.other > 0
    }

    /// True when the only runner error class recorded this pass was a transient
    /// file lock (`EBUSY`) — at least one EBUSY and zero of every other class. The
    /// file-lock counterpart of [`Self::is_exclusively_disk_full`]: like a full
    /// disk, a Windows file lock (another process held the file open on a read) is
    /// a self-healing local-machine condition, not a product defect, and the same
    /// robust, last-wins-immune rollup signal proves the terminal exit was caused
    /// purely by it.
    pub fn is_exclusively_file_locked(&self) -> bool {
        self.ebusy > 0 && !self.has_non_file_lock_error()
    }

    /// True when at least one runner error of a class OTHER than a file lock
    /// (`EBUSY`) was recorded this pass. The file-lock disposition gate requires
    /// this to be false, so a mixed rollup (e.g. `EBUSY:1,EPERM:1`) never
    /// suppresses. Deliberately disjoint from disk exhaustion: an `ENOSPC` here
    /// counts as a non-file-lock error, so the disk-full and file-lock recognizers
    /// can never both fire for one rollup.
    pub fn has_non_file_lock_error(&self) -> bool {
        self.eperm > 0
            || self.eacces > 0
            || self.enospc > 0
            || self.enoent > 0
            || self.eexist > 0
            || self.enotempty > 0
            || self.exdev > 0
            || self.network > 0
            || self.auth > 0
            || self.other > 0
    }

    /// Render only fixed class names and decimal counts. `None` means this
    /// watcher pass saw no runner error records, so no tag should be sent.
    pub fn tag_value(&self) -> Option<String> {
        let counts = [
            (RunnerErrorClass::Eperm, self.eperm),
            (RunnerErrorClass::Eacces, self.eacces),
            (RunnerErrorClass::Enospc, self.enospc),
            (RunnerErrorClass::Ebusy, self.ebusy),
            (RunnerErrorClass::Enoent, self.enoent),
            (RunnerErrorClass::Eexist, self.eexist),
            (RunnerErrorClass::Enotempty, self.enotempty),
            (RunnerErrorClass::Exdev, self.exdev),
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
            (RunnerErrorClass::Enoent, self.enoent),
            (RunnerErrorClass::Eexist, self.eexist),
            (RunnerErrorClass::Enotempty, self.enotempty),
            (RunnerErrorClass::Exdev, self.exdev),
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

/// POSIX SIGABRT. A native abort is reported as this signal by Unix process
/// status APIs, including the macOS watcher event that motivated the merged
/// auto-sync watcher termination group.
pub const SIGABRT_SIGNAL: i32 = 6;

/// Node on Windows reports an abort as this process exit code rather than a
/// Unix signal. The observed Windows watcher event used this convention, so it
/// is normalized with POSIX SIGABRT only when the host is explicitly Windows.
pub const NODE_WINDOWS_ABORT_EXIT: i32 = 134;

/// Host semantics used to interpret a watcher process termination. The host is
/// an explicit input so tests can exercise both wire encodings on every CI
/// platform instead of silently relying on the build machine's operating
/// system.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminationHost {
    Posix,
    Windows,
}

/// Select the production host interpretation. This is intentionally the only
/// cfg-derived part of watcher termination normalization.
pub fn current_termination_host() -> TerminationHost {
    if cfg!(target_os = "windows") {
        TerminationHost::Windows
    } else {
        TerminationHost::Posix
    }
}

/// POSIX SIGKILL. Unlike a bare SIGKILL (which can be an OOM or a force-quit),
/// this is attributable to the app only when an exact-generation cancellation
/// record proves the app escalated a prior cancellation successfully.
pub const SIGKILL_SIGNAL: i32 = 9;

/// POSIX SIGILL — an illegal instruction, always a genuine crash.
pub const SIGILL_SIGNAL: i32 = 4;
/// POSIX SIGBUS on Linux (bus error / bad memory access), a genuine crash.
pub const SIGBUS_SIGNAL_LINUX: i32 = 7;
/// POSIX SIGBUS on macOS/BSD (bus error), a genuine crash. Differs from Linux.
pub const SIGBUS_SIGNAL_MACOS: i32 = 10;
/// POSIX SIGSEGV — a segmentation fault, always a genuine crash.
pub const SIGSEGV_SIGNAL: i32 = 11;
/// POSIX SIGHUP — a controlling-terminal / session hangup. On macOS this is the
/// shape a session end or logout delivers to an unattended child; it is not a
/// fault, but it is unexplained until its producer is named, so it stays
/// alertable while being reported by name rather than as a raw Debug tuple.
pub const SIGHUP_SIGNAL: i32 = 1;
/// POSIX SIGINT — an interactive interrupt (Ctrl-C).
pub const SIGINT_SIGNAL: i32 = 2;

/// True when a termination signal denotes a genuine process crash (segfault,
/// bus error, illegal instruction, abort, or SIGKILL — which can be an OOM
/// kill). A disk-exhaustion exit must never suppress an alert that carries one
/// of these, so the disk-full disposition gate excludes them. SIGTERM is
/// deliberately absent: it is the app's own cancellation signal, not a crash.
pub fn is_crash_signal(signal: Option<i32>) -> bool {
    matches!(
        signal,
        Some(
            SIGABRT_SIGNAL
                | SIGILL_SIGNAL
                | SIGBUS_SIGNAL_LINUX
                | SIGBUS_SIGNAL_MACOS
                | SIGKILL_SIGNAL
                | SIGSEGV_SIGNAL
        )
    )
}

/// The explicit initiator of a manual sync cancellation. This is deliberately
/// a small, closed vocabulary: only cancellation paths owned by the desktop
/// application may make a terminal runner exit attributable to the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncCancelCause {
    UserStop,
    TimeoutWatchdog,
    AppQuit,
    /// The auto-sync daemon's heartbeat-stall watchdog tore down its own wedged
    /// watcher. Distinct from `TimeoutWatchdog` (the manual-sync one-hour
    /// ceiling): this is published by the daemon's stall escalation so the
    /// watcher's terminal boundary can attribute its own SIGKILL through the
    /// durable cancellation record instead of capturing it as an unexplained
    /// external kill when the ephemeral cancelled flag has been lost.
    HeartbeatStall,
}

impl SyncCancelCause {
    /// Stable, content-safe value for local log lines and Sentry context on
    /// residual captures. Do not derive this from user or runner input.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UserStop => "user-stop",
            Self::TimeoutWatchdog => "timeout-watchdog",
            Self::AppQuit => "app-quit",
            Self::HeartbeatStall => "heartbeat-stall",
        }
    }
}

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

/// Fixed-vocabulary attribution for the external Windows terminator status.
///
/// This remains typed until the app-facing Sentry boundary so policy decisions
/// cannot accidentally be driven by an arbitrary string.
///
/// The three `Unattributed*` values are deliberately distinct rather than one
/// catch-all. A single `unattributed` collapsed "no session-end signal ever
/// arrived", "the query phase started but never committed" and "a commit
/// existed but had expired" into one undiagnosable token, which is what made
/// the first recurrence of this defect cost a blind investigation round. Each
/// value now names which link of the chain failed.
///
/// Three of the values are *terminal resolution states*, produced only after a
/// deferral's grace by [`resolved_session_end_attribution`], never read from the
/// message-driven observer at exit time:
///
/// - `SessionEndProbed` — no session-end message ever arrived, but the OS itself
///   confirmed the teardown through the pull-based probe. Suppresses, like an
///   observed session end.
/// - `SessionEndLatched` — no contemporaneous message and no probe confirmation,
///   but a durable, process-global Windows session-end latch was set from
///   positive OS evidence (a committed `WM_ENDSESSION` / same-session WTS logoff,
///   or the app's own non-app-initiated `RunEvent::Exit` branch) while it was
///   still contemporaneous. Suppresses. This is the r3 link: it survives the
///   observer thread dying (`attribution_now` reporting `ObserverFailed`) and the
///   app's one-shot session-end drop sweep having already run.
/// - `UnattributedNoTeardown` — the probe ran and the OS was verifiably *not*
///   tearing down. This is the honest, genuinely alertable case: it tells the
///   next investigation round that the killer is not a Windows session teardown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsTerminatorAttribution {
    SessionEndObserved,
    SessionEndProbed,
    SessionEndLatched,
    UnattributedNoSignal,
    UnattributedQueryOnly,
    UnattributedStaleAffirmation,
    UnattributedNoTeardown,
    ObserverUnavailable,
    ObserverFailed,
}

impl WindowsTerminatorAttribution {
    /// Stable, content-safe token for logs and Sentry tags.
    pub fn class_name(self) -> &'static str {
        match self {
            Self::SessionEndObserved => "session_end_observed",
            Self::SessionEndProbed => "session_end_probed",
            Self::SessionEndLatched => "session_end_latched",
            Self::UnattributedNoSignal => "unattributed_no_signal",
            Self::UnattributedQueryOnly => "unattributed_query_only",
            Self::UnattributedStaleAffirmation => "unattributed_stale_affirmation",
            Self::UnattributedNoTeardown => "unattributed_no_teardown",
            Self::ObserverUnavailable => "observer_unavailable",
            Self::ObserverFailed => "observer_failed",
        }
    }

    /// True for the family that means "the observer was alive and healthy, but
    /// it had no contemporaneous committed session end to offer".
    ///
    /// This family is renamed by the teardown probe at resolution: a confirmed
    /// teardown turns it into `SessionEndProbed` (suppressed) and a verifiably
    /// absent teardown into `UnattributedNoTeardown` (the honest alert). The two
    /// observer-fault readings are NOT in this set (they keep their own raw value
    /// when they send), and the terminal resolution states are excluded because
    /// they are what a re-read *resolves to*, never a raw observer reading.
    pub fn is_unattributed(self) -> bool {
        matches!(
            self,
            Self::UnattributedNoSignal
                | Self::UnattributedQueryOnly
                | Self::UnattributedStaleAffirmation
        )
    }

    /// True for a RAW observer reading that must DEFER on a
    /// `DBG_TERMINATE_PROCESS` watcher exit: the three unattributed readings
    /// PLUS the two observer-fault readings (`ObserverUnavailable`,
    /// `ObserverFailed`).
    ///
    /// The r1 fix deferred only [`is_unattributed`] and delegated the
    /// observer-fault readings to the established capture policy — an immediate
    /// send — on the stated reasoning that a failed observer "cannot start
    /// affirming, so waiting on it would only delay an alert". The r3 recurrence
    /// (indigo-d0/hq-desktop event 5bcd8d2aa8c047768419f18613426a59, v0.10.150,
    /// `windows_terminator=observer_failed`) falsified that: at a real Windows
    /// session end the OS destroys the observer's window, so `attribution_now`
    /// reports `ObserverFailed` at exactly the moment the exit is attributed —
    /// and that reading skipped the r2 teardown probe AND the durable latch and
    /// fired a false alert on the spot. The observer cannot start affirming, but
    /// the probe and the latch can, so every one of these readings now defers so
    /// both are consulted after the grace.
    ///
    /// Excludes `SessionEndObserved` (positive evidence — suppresses at once) and
    /// the three terminal resolution states (`SessionEndProbed`,
    /// `SessionEndLatched`, `UnattributedNoTeardown`), which a re-read resolves to
    /// and must never re-trigger a deferral.
    pub fn is_deferrable_observer_reading(self) -> bool {
        matches!(
            self,
            Self::UnattributedNoSignal
                | Self::UnattributedQueryOnly
                | Self::UnattributedStaleAffirmation
                | Self::ObserverUnavailable
                | Self::ObserverFailed
        )
    }
}

/// A read of the durable, process-global Windows session-end latch, reduced to a
/// content-safe three-state token.
///
/// The latch is a monotonic-millis timestamp written ONLY from positive OS
/// session-end evidence — a committed `WM_ENDSESSION(TRUE)`, a same-session WTS
/// logoff, or the app's own non-app-initiated `RunEvent::Exit` branch. Its
/// contemporaneity is judged by [`session_end_affirms`] on the SAME 20s
/// [`SESSION_END_AFFIRMATION_TTL_MS`] as an observer affirmation, so a latch from
/// a session end minutes ago can never suppress an unrelated later crash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEndLatchReading {
    /// A latch was set contemporaneously with this exit — positive evidence.
    Latched,
    /// The latch was consulted and held no contemporaneous value (never set, or
    /// expired past the TTL). Fails closed: no evidence, so the alert still sends.
    Absent,
    /// The latch could not be consulted at all (a non-Windows build, or a path
    /// like the app-quit flush that deliberately consults nothing).
    Unavailable,
}

impl SessionEndLatchReading {
    /// Stable, content-safe token for logs and Sentry extras.
    pub fn class_name(self) -> &'static str {
        match self {
            Self::Latched => "latched",
            Self::Absent => "absent",
            Self::Unavailable => "unavailable",
        }
    }

    /// Only a contemporaneous latch is positive evidence that suppresses.
    pub fn suppresses(self) -> bool {
        matches!(self, Self::Latched)
    }
}

/// Map a durable latch timestamp (monotonic millis, `None` when unset) read at
/// `now_ms` into the content-safe reading the decision functions consume.
///
/// Contemporaneity reuses [`session_end_affirms`] verbatim, so the latch expires
/// on exactly the 20s [`SESSION_END_AFFIRMATION_TTL_MS`] boundary an observer
/// affirmation does — `None` and an expired stamp both fail closed to `Absent`.
/// This is the whole pure contemporaneity decision; the impure layer only
/// supplies the two millis values from one consistent monotonic clock and maps a
/// genuinely unconsultable latch to [`SessionEndLatchReading::Unavailable`].
pub fn session_end_latch_reading(latched_ms: Option<u64>, now_ms: u64) -> SessionEndLatchReading {
    if session_end_affirms(latched_ms, now_ms) {
        SessionEndLatchReading::Latched
    } else {
        SessionEndLatchReading::Absent
    }
}

/// A committed Windows session-end indication is relevant only while it is
/// contemporaneous with the watcher exit. The strict comparison below makes
/// exactly 20 seconds fail closed.
pub const SESSION_END_AFFIRMATION_TTL_MS: u64 = 20_000;

/// How long a `DBG_TERMINATE_PROCESS` watcher exit that the observer could not
/// yet attribute may hold its Sentry send back, waiting for an affirmation that
/// has not arrived *yet*.
///
/// Windows tears a session down per process. A windowless child is terminated
/// by csrss on its own schedule while the interactive app is given the
/// `WM_QUERYENDSESSION` / `WM_ENDSESSION` courtesy and dies last, so "the child
/// dies first and the app is affirmed a moment later" is the normal ordering at
/// logoff — not an exotic one. [`session_end_affirms`] only ever looked
/// backward, so an affirmation arriving even one millisecond after the child's
/// exit callback could not suppress anything.
///
/// 6 seconds is chosen to sit inside two independent ceilings:
///
/// - well under the 20s [`SESSION_END_AFFIRMATION_TTL_MS`], so a deferral can
///   never outlive the affirmation window it is waiting on; and
/// - under Windows' 5s default `WaitToKillAppTimeout` plus the app's own
///   ~1.75s capped session-end teardown (6.75s), so at a real session end the
///   app reaches its exit path and drops the deferral rather than racing it.
///
/// It is a fixed compile-time constant: this is a bounded delay, never a poll
/// loop and never an unbounded wait.
pub const SESSION_END_GRACE_MS: u64 = 6_000;

/// Whether a recorded session-end signal is contemporaneous with the watcher
/// exit being attributed. Shared by the committed-end check and the query-phase
/// discriminator so both expire on exactly the same boundary.
pub fn session_end_signal_is_fresh(stamp_ms: Option<u64>, now_ms: u64) -> bool {
    matches!(
        stamp_ms,
        Some(stamp) if now_ms.saturating_sub(stamp) < SESSION_END_AFFIRMATION_TTL_MS
    )
}

/// Whether a recorded committed session end is fresh enough to attribute a
/// watcher `DBG_TERMINATE_PROCESS` exit to Windows teardown.
pub fn session_end_affirms(affirmed_end_ms: Option<u64>, now_ms: u64) -> bool {
    session_end_signal_is_fresh(affirmed_end_ms, now_ms)
}

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

/// Return the stable watcher-facing description for the two observed abort
/// encodings. A bare exit 134 is only a Node abort on Windows; retaining the
/// explicit host input prevents POSIX shell-wrapped exit codes from regrouping.
pub fn normalized_abort_description(
    code: Option<i32>,
    signal: Option<i32>,
    host: TerminationHost,
) -> Option<&'static str> {
    match (code, signal, host) {
        (None, Some(SIGABRT_SIGNAL), _) => Some("aborted with SIGABRT"),
        (Some(NODE_WINDOWS_ABORT_EXIT), None, TerminationHost::Windows) => {
            Some("aborted (Node abort exit code 134)")
        }
        _ => None,
    }
}

/// Stable watcher-only fingerprint component that joins Node's Windows abort
/// exit convention with POSIX SIGABRT while leaving every other raw termination
/// token unchanged. The base helper remains the manual-sync wire contract.
pub fn termination_fingerprint_token_for_host(
    code: Option<i32>,
    signal: Option<i32>,
    host: TerminationHost,
) -> String {
    if normalized_abort_description(code, signal, host).is_some() {
        "abort:sigabrt".to_string()
    } else {
        termination_fingerprint_token(code, signal)
    }
}

/// Fixed, content-safe fingerprint token for an auto-sync watcher death that is
/// ATTRIBUTED to runner memory exhaustion. One mechanism — the runner's unbounded
/// mid-pull growth — reaches three host encodings (a SIGKILL, a SIGABRT heap
/// abort, and a Windows fault), so without convergence it emits three
/// fingerprints and groups as three issues. When memory exhaustion is PROVEN,
/// every encoding collapses to this one token. The raw host token is retained in
/// the `termination_status_raw` extra, so nothing is lost.
pub const RUNNER_MEMORY_EXHAUSTION_TOKEN: &str = "runner:memory-exhausted";

/// Evidence that a watcher exit was caused by runner memory exhaustion. Any ONE
/// is sufficient. Attribution is EVIDENCE-GATED on purpose: a bare SIGKILL, a
/// force-quit, an app teardown, or a cancellation with none of these keeps its
/// own termination token — a force-quit must never be relabelled an OOM.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MemoryExhaustionEvidence {
    /// The runner's own stderr proved a V8 heap OOM (`RunnerFatalClass::HeapOom`).
    pub heap_oom_class: bool,
    /// The last COMPARABLE (whole-tree / job) footprint sample was at or above the
    /// declared ceiling. A shim/withheld sample never sets this.
    pub footprint_at_or_above_ceiling: bool,
    /// The app's supervisor pre-empted the runner at its footprint ceiling.
    pub supervisor_preempt: bool,
}

impl MemoryExhaustionEvidence {
    /// True when at least one evidence source proves memory exhaustion.
    pub fn is_attributed(self) -> bool {
        self.heap_oom_class || self.footprint_at_or_above_ceiling || self.supervisor_preempt
    }
}

/// Evidence-gated watcher fingerprint token. When memory exhaustion is proven,
/// collapse every host encoding to [`RUNNER_MEMORY_EXHAUSTION_TOKEN`]; otherwise
/// fall through to [`termination_fingerprint_token_for_host`] UNCHANGED, so an
/// exit with no memory evidence produces exactly today's token (a bare SIGKILL
/// stays `signal:9`).
pub fn watcher_termination_fingerprint_token(
    code: Option<i32>,
    signal: Option<i32>,
    host: TerminationHost,
    memory_evidence: MemoryExhaustionEvidence,
) -> String {
    if memory_evidence.is_attributed() {
        return RUNNER_MEMORY_EXHAUSTION_TOKEN.to_string();
    }
    termination_fingerprint_token_for_host(code, signal, host)
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

/// Closed, content-safe vocabulary naming the DISPOSITION of the signal that
/// terminated an auto-sync watcher, so a signal-only termination is filterable in
/// Sentry without parsing the message text. Every arm returns a fixed token that
/// carries no machine-specific byte, and the returned value is independently
/// re-validated at the telemetry egress.
///
/// The `fault` arm is defined by [`is_crash_signal`] so it can never drift from
/// the fault set the watcher-exit seam already alerts on
/// (SIGABRT/SIGBUS/SIGILL/SIGKILL/SIGSEGV); a drift-guard test in `daemon.rs`
/// additionally pins it to `is_fault_signal`. The remaining arms name SIGTERM
/// (`cancel`), SIGHUP (`hangup`), and SIGINT (`interrupt`); any other signal is
/// `other`, and a signal-free exit is `none`.
pub fn watcher_exit_signal_class(signal: Option<i32>) -> &'static str {
    match signal {
        None => "none",
        Some(sig) if is_crash_signal(Some(sig)) => "fault",
        Some(SIGTERM_SIGNAL) => "cancel",
        Some(SIGHUP_SIGNAL) => "hangup",
        Some(SIGINT_SIGNAL) => "interrupt",
        Some(_) => "other",
    }
}

/// Explicit Sentry policy for an auto-sync watcher termination.
///
/// `Capture` retains the normal crash-loop milestone limiter at the caller.
/// `CaptureRateLimited` is reserved for failures that are initially
/// environmental but need an escalating, milestone-limited alert if they
/// persist. `LocalLogOnly` records a breadcrumb without creating an event.
/// `DeferSessionEndDecision` is `Capture` with its *send* held back for
/// [`SESSION_END_GRACE_MS`] so a session-end affirmation that lands just after
/// the watcher's exit callback can still be honoured; it never cancels an
/// alert, and the caller's lifecycle, failure category and crash-loop counting
/// are identical to `Capture`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatcherExitCapturePolicy {
    Capture,
    CaptureRateLimited,
    LocalLogOnly,
    DeferSessionEndDecision,
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

/// Extend the existing watcher-exit policy with a session attribution and a
/// durable session-end latch, both of which are now two-sided in time.
///
/// Exactly one exit shape — `DBG_TERMINATE_PROCESS`, no signal — can consult the
/// observer, the probe or the latch at all. Within it:
///
/// - positive evidence AT EXIT suppresses immediately: a contemporaneous durable
///   latch, or an observed session-end message. Either yields `LocalLogOnly`;
/// - every RAW observer reading without positive evidence at exit now DEFERS the
///   send (see [`SESSION_END_GRACE_MS`]) so the r2 teardown probe and the latch
///   are consulted after the grace. This is the r3 widening: it now includes the
///   observer-fault readings (`ObserverUnavailable`, `ObserverFailed`), which r1
///   sent immediately — the exact reading (`observer_failed`) the recurrence
///   fired on ([`WindowsTerminatorAttribution::is_deferrable_observer_reading`]);
/// - the terminal resolution states, a `None` reading, and every other exit
///   shape delegate to the established policy verbatim, so a re-read can never
///   re-defer and a real fault status stays alertable.
pub fn watcher_exit_capture_policy_with_attribution(
    code: Option<i32>,
    signal: Option<i32>,
    attribution: Option<WindowsTerminatorAttribution>,
    latch: SessionEndLatchReading,
) -> WatcherExitCapturePolicy {
    if code != Some(WINDOWS_SESSION_TERMINATE_EXIT) || signal.is_some() {
        return watcher_exit_capture_policy(code, signal);
    }
    // Positive evidence at exit time suppresses on the spot, exactly like an
    // observed message: a contemporaneous latch is committed OS session-end
    // evidence that survives the observer thread's death.
    if latch.suppresses()
        || attribution == Some(WindowsTerminatorAttribution::SessionEndObserved)
    {
        return WatcherExitCapturePolicy::LocalLogOnly;
    }
    match attribution {
        // Every raw observer reading without positive evidence defers so the
        // probe and the latch get a second look before an alert fires.
        Some(reading) if reading.is_deferrable_observer_reading() => {
            WatcherExitCapturePolicy::DeferSessionEndDecision
        }
        // A terminal resolution state or an absent reading delegates verbatim; it
        // must never re-trigger a deferral.
        _ => watcher_exit_capture_policy(code, signal),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pull-based Windows teardown probe (second evidence dimension)
// ─────────────────────────────────────────────────────────────────────────────
//
// The observer (message-driven, push-only) can only suppress a teardown that
// Windows ANNOUNCED with a window message. A forced end-session — `ExitWindowsEx`
// with `EWX_FORCE`, and the equivalent forced logoff/restart paths — terminates
// child processes WITHOUT sending `WM_QUERYENDSESSION`/`WM_ENDSESSION`, so the
// observer stays empty for the whole grace and the false alert fails closed.
//
// This probe adds the missing dimension: it *asks the OS* rather than waiting to
// be told, through two independent pull sources, and combines them into a fixed
// three-state verdict. The types are `target_os`-agnostic so every platform's
// test job pins the Windows wire values.

/// What `GetSystemMetrics(SM_SHUTTINGDOWN)` reported. `Unavailable` covers a
/// platform that has no such query at all (every non-Windows build), keeping
/// "the OS says no" strictly distinct from "we could not ask".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeardownShuttingDown {
    Yes,
    No,
    Unavailable,
}

impl TeardownShuttingDown {
    /// Content-safe token for the `windows_teardown_probe_shuttingdown` extra.
    pub fn class_name(self) -> &'static str {
        match self {
            Self::Yes => "yes",
            Self::No => "no",
            Self::Unavailable => "unavailable",
        }
    }
}

/// Which System-channel shutdown/logoff-initiation record class the bounded
/// sweep matched. Every variant is a fixed token; a record NEVER contributes its
/// raw text, initiating user, process path, machine name or timestamp beyond a
/// bare unix-millis integer used only for the bracketing comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeardownLogClass {
    /// User32 EventID 1074 — a process (or the user) initiated a shutdown/restart.
    User32Initiated,
    /// Microsoft-Windows-Kernel-General EventID 13 — the OS is shutting down.
    KernelGeneral,
    /// Microsoft-Windows-Kernel-Power EventID 109 — kernel power/shutdown.
    KernelPower,
}

impl TeardownLogClass {
    /// Content-safe token for the `windows_teardown_probe_log` extra.
    pub fn class_name(self) -> &'static str {
        match self {
            Self::User32Initiated => "user32_1074",
            Self::KernelGeneral => "kernel_general_13",
            Self::KernelPower => "kernel_power_109",
        }
    }

    /// Whether this record is evidence the teardown actually PROCEEDED, as
    /// opposed to merely being *initiated*.
    ///
    /// User32 EventID 1074 is an initiation record: a process asked Windows to
    /// shut down or restart. That request can still be aborted or vetoed
    /// (`shutdown /a`, an app returning FALSE to `WM_QUERYENDSESSION`), so a bare
    /// 1074 is the log-side equivalent of the observer's query phase — it must
    /// never suppress a real watcher crash that merely coincides with it inside
    /// the bracketing window. Kernel-General 13 ("the operating system is
    /// shutting down") and Kernel-Power 109 are written as the OS commits to the
    /// teardown, so they are the ones that confirm it proceeded.
    pub fn is_committed_teardown(self) -> bool {
        matches!(self, Self::KernelGeneral | Self::KernelPower)
    }
}

/// One parsed, content-safe System-channel teardown record. `class` is an
/// allow-listed token and `event_time_unix_ms` is a bare integer used solely to
/// decide whether the record brackets the watcher exit; nothing else is retained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TeardownRecord {
    pub class: TeardownLogClass,
    pub event_time_unix_ms: Option<i64>,
}

/// Outcome of the bounded System-channel sweep. `Unavailable` (channel could not
/// be opened) is deliberately distinct from `None` (channel opened and held no
/// *bracketing* record) so an unreadable channel fails closed to `Unknown`
/// rather than masquerading as positive proof of absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TeardownLogReading {
    Record(TeardownLogClass),
    None,
    Unavailable,
}

impl TeardownLogReading {
    /// Content-safe token for the `windows_teardown_probe_log` extra.
    pub fn class_name(self) -> &'static str {
        match self {
            Self::Record(class) => class.class_name(),
            Self::None => "none",
            Self::Unavailable => "unavailable",
        }
    }
}

/// The full set of pull-based observations gathered across a deferral, combined
/// into a verdict by the pure [`windows_teardown_verdict`] below so the decision
/// is unit-testable without any real syscall.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowsTeardownProbeReading {
    /// `SM_SHUTTINGDOWN` sampled inline at watcher-exit attribution time.
    pub shuttingdown_at_exit: TeardownShuttingDown,
    /// `SM_SHUTTINGDOWN` sampled again at grace resolution, six seconds later.
    pub shuttingdown_at_resolve: TeardownShuttingDown,
    /// The System-channel sweep result, completed concurrently inside the grace.
    pub log: TeardownLogReading,
}

/// The fixed three-state verdict of the teardown probe. Fail-closed by
/// construction: only [`Confirmed`](Self::Confirmed) is positive evidence that a
/// deferral may act on to suppress; `Absent` and `Unknown` both keep the alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsTeardownVerdict {
    Confirmed,
    Absent,
    Unknown,
}

impl WindowsTeardownVerdict {
    /// Content-safe token for the `windows_teardown_probe_verdict` extra.
    pub fn class_name(self) -> &'static str {
        match self {
            Self::Confirmed => "teardown_confirmed",
            Self::Absent => "teardown_absent",
            Self::Unknown => "teardown_unknown",
        }
    }
}

/// Combine the probe's observations into a verdict.
///
/// The rule is deliberately asymmetric and fail-closed:
///
/// - A positive confirmation is either a live `SM_SHUTTINGDOWN` read (taken six
///   seconds apart precisely so a flag that sets late is still caught) or a
///   System-channel record proving the teardown actually PROCEEDED
///   ([`TeardownLogClass::is_committed_teardown`]). An initiation-only record
///   (User32 1074) does NOT confirm on its own: a shutdown can be initiated and
///   then aborted, so it is the log-side query phase and must not suppress a real
///   watcher crash that merely coincides with it.
/// - `Absent` requires positive negative evidence from *every* source: both
///   flags read `No` AND the channel opened and held no bracketing record at all
///   — not even an initiation. Only then can the probe assert the OS was
///   verifiably not tearing down.
/// - Anything else — an unreadable channel, an unavailable flag, a bracketing
///   *initiation-only* record, any mix short of unanimous negatives — is
///   `Unknown`, which the caller must treat exactly like today's behaviour and
///   send. The record class is still stamped on the diagnostics for the next
///   round.
pub fn windows_teardown_verdict(reading: WindowsTeardownProbeReading) -> WindowsTeardownVerdict {
    let committed_teardown_record = matches!(
        reading.log,
        TeardownLogReading::Record(class) if class.is_committed_teardown()
    );
    if reading.shuttingdown_at_exit == TeardownShuttingDown::Yes
        || reading.shuttingdown_at_resolve == TeardownShuttingDown::Yes
        || committed_teardown_record
    {
        return WindowsTeardownVerdict::Confirmed;
    }
    if reading.shuttingdown_at_exit == TeardownShuttingDown::No
        && reading.shuttingdown_at_resolve == TeardownShuttingDown::No
        && reading.log == TeardownLogReading::None
    {
        return WindowsTeardownVerdict::Absent;
    }
    WindowsTeardownVerdict::Unknown
}

/// True when a parsed teardown record is contemporaneous with the watcher exit
/// it is being weighed against. Modelled on the WER fault reader's generation
/// window: a shutdown/restart is initiated shortly before the child dies (the
/// `WaitToKill` allowance) and the record may be published slightly after, so
/// the window brackets the exit on both sides. A record with no timestamp is
/// conservatively treated as NOT bracketing — absence of a time is not evidence.
///
/// The window is anchored on [`SESSION_END_AFFIRMATION_TTL_MS`] so it shares the
/// same 20s freshness boundary the observer's committed-end check uses: a
/// shutdown initiated more than a session-affirmation-window before the exit is
/// no more contemporaneous than a stale committed end, and a boot-time record
/// from a previous session (minutes or hours earlier) can never match.
pub fn teardown_record_brackets_exit(
    record: &TeardownRecord,
    exit_unix_ms: i64,
    now_unix_ms: i64,
) -> bool {
    let Some(event_ms) = record.event_time_unix_ms else {
        return false;
    };
    let window_start = exit_unix_ms.saturating_sub(SESSION_END_AFFIRMATION_TTL_MS as i64);
    // The forward edge extends a little past "now" (the sweep's latest read) to
    // tolerate small clock skew between the event log's stamp and the reader.
    let window_end = now_unix_ms.saturating_add(SESSION_END_AFFIRMATION_TTL_MS as i64);
    event_ms >= window_start && event_ms <= window_end
}

/// Parse one rendered System-channel event to a content-safe teardown record,
/// WITHOUT retaining any raw byte. Gated on the exact provider + EventID of the
/// three teardown-initiation records; every other event (and any record whose
/// provider/id does not match) returns `None`. Only the event's `TimeCreated`
/// stamp is read beyond the class gate, and only as a bare integer.
pub fn parse_teardown_record(xml: &str) -> Option<TeardownRecord> {
    let class = classify_teardown_event(xml)?;
    Some(TeardownRecord {
        class,
        event_time_unix_ms: teardown_event_time_ms(xml),
    })
}

/// Classify a rendered System-channel event by its provider name + EventID. Each
/// arm requires BOTH the provider and its id so an unrelated event that happens
/// to carry one of these ids under a different provider is rejected.
fn classify_teardown_event(xml: &str) -> Option<TeardownLogClass> {
    if event_has_provider(xml, "User32") && event_has_id(xml, 1074) {
        return Some(TeardownLogClass::User32Initiated);
    }
    if event_has_provider(xml, "Microsoft-Windows-Kernel-General") && event_has_id(xml, 13) {
        return Some(TeardownLogClass::KernelGeneral);
    }
    if event_has_provider(xml, "Microsoft-Windows-Kernel-Power") && event_has_id(xml, 109) {
        return Some(TeardownLogClass::KernelPower);
    }
    None
}

/// True when the rendered event names `provider` in its `System/Provider @Name`.
/// Tolerant of attribute ordering and single/double quoting; case-sensitive on
/// the provider string, which Windows emits verbatim.
fn event_has_provider(xml: &str, provider: &str) -> bool {
    xml.contains(&format!("Name='{provider}'")) || xml.contains(&format!("Name=\"{provider}\""))
}

/// True when the rendered event's `<EventID>` element text equals `id`.
fn event_has_id(xml: &str, id: u32) -> bool {
    let needle = id.to_string();
    xml.split("<EventID")
        .skip(1)
        .filter_map(|rest| rest.split_once('>'))
        .filter_map(|(_, tail)| tail.split_once("</EventID>"))
        .any(|(value, _)| value.trim() == needle)
}

/// Extract `System/TimeCreated SystemTime='…'` as unix milliseconds, mirroring
/// the WER reader. Returns `None` when absent or unparseable; the bare integer is
/// the only field read from the record beyond its class.
fn teardown_event_time_ms(xml: &str) -> Option<i64> {
    let after = xml.split("SystemTime=").nth(1)?;
    let quote = after.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let value = after[quote.len_utf8()..].split(quote).next()?;
    chrono::DateTime::parse_from_rfc3339(value.trim())
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// What a deferred session-end capture must do once its grace has elapsed and
/// the attribution has been read a second time.
///
/// Deliberately fail-closed and deliberately narrow: only positive OS evidence
/// drops the event — an observed session-end message, or a probe that confirmed
/// the teardown. A still-unattributed reading with no probe confirmation, a
/// failed observer, or an observer that vanished all send the alert that was
/// held back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeferredSessionEndOutcome {
    Drop,
    Capture,
}

/// Resolve a deferred session-end capture against the re-read attribution, the
/// pull-based teardown verdict, and the durable session-end latch.
///
/// Fail-closed: ONLY positive OS session-end evidence drops a held alert, and
/// there are exactly three independent positive sources, any one of which
/// suffices —
///
/// 1. the observer saw the committed session-end message (`SessionEndObserved`);
/// 2. a durable latch was set contemporaneously from a committed
///    `WM_ENDSESSION` / same-session WTS logoff / the app's own session-end exit
///    branch ([`SessionEndLatchReading::suppresses`]); or
/// 3. the pull-based probe caught the OS mid-teardown (`Confirmed`).
///
/// The r3 change is that (2) and (3) now drop for the observer-fault readings
/// too, not only the unattributed family: a failed observer paired with a
/// confirmed teardown or a contemporaneous latch is a false alarm, not a crash.
/// Everything else — `Absent`, `Unknown`, an absent/expired latch, an unread
/// probe — captures verbatim.
pub fn deferred_session_end_outcome(
    attribution: WindowsTerminatorAttribution,
    verdict: WindowsTeardownVerdict,
    latch: SessionEndLatchReading,
) -> DeferredSessionEndOutcome {
    let observed = attribution == WindowsTerminatorAttribution::SessionEndObserved;
    let confirmed = verdict == WindowsTeardownVerdict::Confirmed;
    if observed || latch.suppresses() || confirmed {
        DeferredSessionEndOutcome::Drop
    } else {
        DeferredSessionEndOutcome::Capture
    }
}

/// Name the resolved `windows_terminator` tag once a deferral's grace has run,
/// keeping the outcome and the tag in lockstep with [`deferred_session_end_outcome`]
/// so a suppressed alert always carries a suppressing tag and a sent alert a
/// sending one. This only *names* the result so a recurrence stays
/// self-diagnosing, and it names WHICH of the three links fired:
///
/// - an observed session end keeps its own (already suppressing) value;
/// - a contemporaneous durable latch becomes `SessionEndLatched` (suppressed) —
///   for the observer-fault readings as well as the unattributed ones;
/// - the OS-confirmed teardown becomes `SessionEndProbed` (suppressed);
/// - with no positive evidence the alert SENDS: an unattributed reading the OS
///   verifiably denied becomes the honest `UnattributedNoTeardown`, and every
///   other reading (an unattributed one the probe could not settle, or an
///   observer-fault reading) keeps its own raw value.
pub fn resolved_session_end_attribution(
    attribution: WindowsTerminatorAttribution,
    verdict: WindowsTeardownVerdict,
    latch: SessionEndLatchReading,
) -> WindowsTerminatorAttribution {
    // Priority mirrors the drop decision: the strongest positive source names
    // the tag. Observed is strongest and keeps its own value.
    if attribution == WindowsTerminatorAttribution::SessionEndObserved {
        return attribution;
    }
    if latch.suppresses() {
        return WindowsTerminatorAttribution::SessionEndLatched;
    }
    if verdict == WindowsTeardownVerdict::Confirmed {
        return WindowsTerminatorAttribution::SessionEndProbed;
    }
    // No positive evidence — the alert is SENT. Name the honest reason.
    match (attribution.is_unattributed(), verdict) {
        (true, WindowsTeardownVerdict::Absent) => {
            WindowsTerminatorAttribution::UnattributedNoTeardown
        }
        _ => attribution,
    }
}

/// Content-safe bucket for how long a deferred session-end capture actually
/// waited. A raw millisecond count is a timing side channel with no triage
/// value; the bucket answers the only question that matters — did the grace run
/// to completion, or did something resolve it early.
pub fn session_end_grace_waited_bucket(waited_ms: u64) -> &'static str {
    match waited_ms {
        0..=999 => "under_1s",
        1_000..=2_999 => "1s_to_3s",
        3_000..=5_999 => "3s_to_6s",
        _ => "at_or_over_6s",
    }
}

/// Preserve the existing power-of-two crash-loop dampening while making the
/// exec-not-runnable escalation explicit and table-testable.
pub fn should_capture_watcher_exit(policy: WatcherExitCapturePolicy, consecutive: u32) -> bool {
    match policy {
        WatcherExitCapturePolicy::LocalLogOnly => false,
        // A deferral is a `Capture` whose send is delayed, so it inherits the
        // same milestone limiter: a crash loop must not become a deferral loop
        // that outruns it.
        WatcherExitCapturePolicy::Capture | WatcherExitCapturePolicy::DeferSessionEndDecision => {
            is_capture_milestone(consecutive)
        }
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
    /// Surface the actionable free-up-space message without a capture. The run
    /// ended solely because the disk is full (`ENOSPC`); like the other
    /// non-alerting terminal dispositions, callers must still emit exactly one
    /// terminal UI event so both desktop surfaces leave the syncing state.
    DiskFull,
    /// Surface the actionable close-the-other-app message without a capture. The
    /// run ended solely because a file was held open by another process
    /// (`EBUSY`) — a transient, self-healing local condition, exactly like a
    /// transient network blip. Like the other non-alerting terminal
    /// dispositions, callers must still emit exactly one terminal UI event so
    /// both desktop surfaces leave the syncing state.
    FileLocked,
    /// End the UI run after an exact run was observably stopped by the desktop
    /// app. This is intentionally distinct from generic `Ignore`: callers must
    /// still emit one terminal UI event so both desktop surfaces leave syncing.
    CancelledByApp(SyncCancelCause),
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

/// Classify a manual-sync terminal exit with exact-generation cancellation
/// evidence. The existing classifier remains the compatibility policy for all
/// callers that do not own an observed cancellation record.
///
/// A cancellation must satisfy four gates before it becomes a suppression:
/// it has a known app-owned cause, the termination call observably succeeded,
/// the terminal status matches that termination, and no alertable runner error
/// was seen. This preserves real runner faults that race a Stop, timeout, or
/// application quit.
pub fn classify_runner_exit_disposition_with_cancellation(
    code: Option<i32>,
    signal: Option<i32>,
    cause: Option<SyncCancelCause>,
    termination_effected: bool,
    saw_error: bool,
    saw_alertable_error: bool,
    saw_node_too_old: bool,
) -> RunnerExitDisposition {
    // Preserve the legacy outcome for any alertable runner fault. In
    // particular this prevents a successful app cancellation from hiding a
    // concurrent EPERM / EISDIR-style runner failure.
    if saw_alertable_error {
        return classify_runner_exit_disposition(
            code,
            signal,
            saw_error,
            saw_alertable_error,
            saw_node_too_old,
        );
    }

    let exit_matches_app_termination = match current_termination_host() {
        TerminationHost::Windows => code == Some(1) && signal.is_none(),
        TerminationHost::Posix => {
            code.is_none() && matches!(signal, Some(SIGTERM_SIGNAL) | Some(SIGKILL_SIGNAL))
        }
    };
    if let Some(cause) = cause.filter(|_| termination_effected && exit_matches_app_termination) {
        return RunnerExitDisposition::CancelledByApp(cause);
    }

    classify_runner_exit_disposition(
        code,
        signal,
        saw_error,
        saw_alertable_error,
        saw_node_too_old,
    )
}

/// Watcher-boundary projection of
/// [`classify_runner_exit_disposition_with_cancellation`].
///
/// The auto-sync watcher's terminal boundary needs only a yes/no: does a durable
/// cancellation record prove the *app itself* terminated this watcher? It answers
/// by delegating to the manual-sync classifier and projecting `CancelledByApp`,
/// so the two boundaries can never drift apart on the four gates — cause present,
/// termination observably effected, exit shape matching an app teardown, and no
/// alertable runner error.
///
/// `saw_error` and `saw_node_too_old` cannot change a `CancelledByApp` verdict:
/// they only steer the *non*-attributing fallback, which never yields
/// `CancelledByApp`. So the boundary is spared threading them, and
/// `watcher_boundary_matches_full_classifier` pins that reduction against the
/// full input lattice.
pub fn watcher_exit_attributed_to_app_teardown(
    code: Option<i32>,
    signal: Option<i32>,
    cause: Option<SyncCancelCause>,
    termination_effected: bool,
    saw_alertable_error: bool,
) -> bool {
    matches!(
        classify_runner_exit_disposition_with_cancellation(
            code,
            signal,
            cause,
            termination_effected,
            saw_alertable_error,
            saw_alertable_error,
            false,
        ),
        RunnerExitDisposition::CancelledByApp(_)
    )
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

/// Fixed, content-safe user-facing message for a sync run that ended because the
/// disk filled. Follows the [`crate::hq_cli_update`] `DISK_FULL_DETAIL` pattern —
/// name the condition, name the one action, name the retry — but is worded for
/// the sync lane (write, not install). Never names a specific volume and never
/// interpolates a path, exit code, or runner byte, so it is safe on both the
/// user-facing `sync:error` event and any breadcrumb. Every disk-full terminal
/// event sources this one constant so the wording cannot drift between routes.
pub const SYNC_DISK_FULL_DETAIL: &str =
    "HQ Sync ran out of space while writing files. Free up space on the drive that holds your HQ folder, then try Sync again.";

/// Fixed, content-safe user-facing message for a sync run that ended because a
/// file was held open by another process (`EBUSY`). Mirrors the
/// [`SYNC_DISK_FULL_DETAIL`] pattern — name the condition, name the one action,
/// name the retry — but is worded for a transient local file lock (close the app
/// holding the file, not free space). Never names a specific file and never
/// interpolates a path, exit code, company slug, or runner byte, so it is safe on
/// both the user-facing `sync:error` event and any breadcrumb. Every file-lock
/// terminal event sources this one constant so the wording cannot drift between
/// routes.
pub const SYNC_FILE_LOCKED_DETAIL: &str =
    "HQ Sync couldn't read a file because another program had it open. Close any app that is using your HQ folder, then try Sync again.";

/// True only for a Windows native-fault exit code — the `0xC000_xxxx` NTSTATUS
/// range (e.g. `0xC0000005` access violation, `0xC0000409` stack-buffer overrun).
/// On Windows a native crash is reported in `code` with `signal == None`, so the
/// POSIX signal gate alone would let a real fault that co-occurs with ENOSPC be
/// suppressed as disk-full; this excludes it (HQ-DESKTOP-5D review: keep Windows
/// fault exits alertable after ENOSPC). A conventional small code (1, 2, …) is
/// `WindowsTermination::Ordinary` and never matches.
pub fn is_windows_fault_exit(code: Option<i32>) -> bool {
    matches!(
        code.map(classify_windows_exit_status),
        Some(WindowsTermination::Fault(_))
    )
}

/// The content half of the disk-exhaustion recognizer, independent of the exit
/// code/signal (which the two routes learn at different seams). A terminal exit
/// is attributable purely to a full disk only when BOTH:
///   (a) the parsed error rollup is exclusively ENOSPC — the robust,
///       last-wins-immune signal that a real hq-cloud/runner write hit ENOSPC; and
///   (b) NO genuine crash class was seen anywhere in the pass (`saw_genuine_crash`
///       is sticky, so a trailing npm companion line that overwrites the retained
///       `runner_fatal_class` cannot mask an earlier crash).
///
/// Requiring the parsed rollup deliberately excludes the npm-own-`ENOSPC` and npm
/// lifecycle startup shapes that emit NO protocol error: those may have filled a
/// separate npx-cache/home volume rather than the HQ-folder drive, and per-line
/// classification cannot see npm's multi-line lifecycle markers — so they must
/// keep alerting rather than route to the HQ-folder free-space message
/// (HQ-DESKTOP-5D review: npm-cache drive + per-line lifecycle context). Pure and
/// content-safe: reads only a bool and integer counts.
pub fn runner_fault_is_disk_exhaustion_content(
    saw_genuine_crash: bool,
    error_rollup: &RunnerErrorRollup,
) -> bool {
    !saw_genuine_crash && error_rollup.is_exclusively_disk_full()
}

/// Whether a terminal runner exit is fully explained by disk exhaustion and
/// nothing else — the SHARED recognizer used by both the manual-sync exit
/// classifier and the auto-sync watcher boundary, so the two can never disagree.
/// Adds the crash-exit gates on top of [`runner_fault_is_disk_exhaustion_content`]:
/// a POSIX crash signal or a Windows native-fault code is never a disk-full exit.
/// Pure and content-safe.
pub fn runner_exit_is_disk_exhaustion(
    code: Option<i32>,
    signal: Option<i32>,
    saw_genuine_crash: bool,
    error_rollup: &RunnerErrorRollup,
) -> bool {
    !is_crash_signal(signal)
        && !is_windows_fault_exit(code)
        && runner_fault_is_disk_exhaustion_content(saw_genuine_crash, error_rollup)
}

/// The content half of the file-lock recognizer, independent of the exit
/// code/signal (which the two routes learn at different seams). Mirrors
/// [`runner_fault_is_disk_exhaustion_content`] exactly for the `EBUSY` class: a
/// terminal exit is attributable purely to a transient file lock only when BOTH
///   (a) the parsed error rollup is exclusively `EBUSY` — the robust,
///       last-wins-immune signal that a real runner read hit a held-open file; and
///   (b) NO genuine crash class was seen anywhere in the pass (`saw_genuine_crash`
///       is sticky, so a trailing companion line cannot mask an earlier crash).
/// Requiring the parsed rollup deliberately excludes any startup shape that emits
/// no protocol error, exactly as the disk-full content half does. Pure and
/// content-safe: reads only a bool and integer counts.
pub fn runner_fault_is_file_lock_content(
    saw_genuine_crash: bool,
    error_rollup: &RunnerErrorRollup,
) -> bool {
    !saw_genuine_crash && error_rollup.is_exclusively_file_locked()
}

/// Whether a terminal runner exit is fully explained by a transient file lock and
/// nothing else — the SHARED recognizer used by both the manual-sync exit
/// classifier and the auto-sync watcher boundary, so the two can never disagree.
/// On top of [`runner_fault_is_file_lock_content`] it requires a signal-free exit
/// and excludes any Windows native-fault code.
///
/// This is deliberately STRICTER than the disk-exhaustion recognizer: it demands
/// `signal.is_none()`, not merely "not a listed crash signal". The observed benign
/// file-lock shape always exits with a conventional code and no signal, so any
/// signal-terminated run stays alertable — including fatal signals outside
/// [`is_crash_signal`]'s set such as SIGFPE, SIGQUIT, or SIGSYS (HQ-DESKTOP-5R
/// review). A Windows native fault is reported in `code` with `signal == None`, so
/// the fault-code veto is still required. Pure and content-safe.
pub fn runner_exit_is_file_lock(
    code: Option<i32>,
    signal: Option<i32>,
    saw_genuine_crash: bool,
    error_rollup: &RunnerErrorRollup,
) -> bool {
    signal.is_none()
        && !is_windows_fault_exit(code)
        && runner_fault_is_file_lock_content(saw_genuine_crash, error_rollup)
}

/// Fault-aware manual-sync exit disposition. Layers disk-exhaustion and
/// file-lock recognition on top of
/// [`classify_runner_exit_disposition_with_cancellation`]: an otherwise-`Alert`
/// verdict for a run whose only fault was a full disk becomes `DiskFull`, and one
/// whose only fault was a transient file lock (`EBUSY`) becomes `FileLocked` —
/// each a no-capture, one-actionable-terminal-event outcome. The two rewrites are
/// mutually exclusive (each needs its own errno class to be the rollup's only
/// class). EVERY other verdict — `NodeTooOld`, `WindowsConsoleControl`,
/// `TransientRetry`, `CancelledByApp`, `Ignore`, and a genuine `Alert` — is
/// returned unchanged, so no existing disposition moves for any input. Pure.
///
/// The arg list mirrors [`classify_runner_exit_disposition_with_cancellation`]
/// plus the sticky crash flag and the error rollup; threading them keeps the
/// classifier pure rather than reading run globals.
#[allow(clippy::too_many_arguments)]
pub fn classify_runner_exit_disposition_with_fault(
    code: Option<i32>,
    signal: Option<i32>,
    cause: Option<SyncCancelCause>,
    termination_effected: bool,
    saw_error: bool,
    saw_alertable_error: bool,
    saw_node_too_old: bool,
    saw_genuine_crash: bool,
    error_rollup: &RunnerErrorRollup,
) -> RunnerExitDisposition {
    let base = classify_runner_exit_disposition_with_cancellation(
        code,
        signal,
        cause,
        termination_effected,
        saw_error,
        saw_alertable_error,
        saw_node_too_old,
    );
    if base != RunnerExitDisposition::Alert {
        return base;
    }
    // The disk-full and file-lock rewrites are mutually exclusive by
    // construction: each requires its own errno class to be the ONLY class in the
    // rollup, so at most one recognizer can fire for a given rollup. Disk-full
    // keeps its existing position; neither can move a non-`Alert` verdict.
    if runner_exit_is_disk_exhaustion(code, signal, saw_genuine_crash, error_rollup) {
        RunnerExitDisposition::DiskFull
    } else if runner_exit_is_file_lock(code, signal, saw_genuine_crash, error_rollup) {
        RunnerExitDisposition::FileLocked
    } else {
        base
    }
}

/// Fault-aware boolean projection for capture seams that have no cancellation
/// record (the auto-sync watcher's terminal boundary). Returns `false` for a
/// disk-exhaustion OR a file-lock exit — neither of which must ever alert — and
/// otherwise mirrors [`should_alert_on_nonzero_exit`] exactly. Every boolean
/// capture seam projects from the same two recognizers rather than re-deriving
/// them.
pub fn should_alert_on_nonzero_exit_with_fault(
    code: Option<i32>,
    signal: Option<i32>,
    saw_error: bool,
    saw_alertable_error: bool,
    saw_node_too_old: bool,
    saw_genuine_crash: bool,
    error_rollup: &RunnerErrorRollup,
) -> bool {
    should_alert_on_nonzero_exit(code, signal, saw_error, saw_alertable_error, saw_node_too_old)
        && !runner_exit_is_disk_exhaustion(code, signal, saw_genuine_crash, error_rollup)
        && !runner_exit_is_file_lock(code, signal, saw_genuine_crash, error_rollup)
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

    // ── grouping / suppression invariance (attribution must only ADD info) ───────
    //
    // The message-shape / path-root / provenance attribution added for
    // HQ-DESKTOP-4T must never change how a runner exit groups or whether it
    // alerts. These pins lock the exact pre-change return values of every token
    // and decision the plan declares off-limits, so a future edit that turns
    // attribution into re-grouping or suppression fails loudly.

    #[test]
    fn runner_error_class_group_tokens_are_pinned() {
        // fingerprint_token drives Sentry grouping; tag_name drives the tag value.
        // The Auth breadcrumb-token rename must not have touched either.
        let pinned = [
            (RunnerErrorClass::Eperm, "EPERM", "eperm"),
            (RunnerErrorClass::Eacces, "EACCES", "eacces"),
            (RunnerErrorClass::Enospc, "ENOSPC", "enospc"),
            (RunnerErrorClass::Ebusy, "EBUSY", "ebusy"),
            // New errno classes (HQ-DESKTOP-4T r2). The pre-existing seven rows
            // above/below MUST stay byte-identical so Sentry grouping and history
            // survive; these four are added, never substituted.
            (RunnerErrorClass::Enoent, "ENOENT", "enoent"),
            (RunnerErrorClass::Eexist, "EEXIST", "eexist"),
            (RunnerErrorClass::Enotempty, "ENOTEMPTY", "enotempty"),
            (RunnerErrorClass::Exdev, "EXDEV", "exdev"),
            (RunnerErrorClass::Network, "NETWORK", "network"),
            (RunnerErrorClass::Auth, "AUTH", "auth"),
            (RunnerErrorClass::Other, "OTHER", "other"),
        ];
        for (class, tag, fingerprint) in pinned {
            assert_eq!(class.tag_name(), tag);
            assert_eq!(class.fingerprint_token(), fingerprint);
        }
        // Completeness: every ALL variant is pinned above, so a future variant
        // added without a pinned tag/fingerprint pair fails here.
        assert_eq!(pinned.len(), RunnerErrorClass::ALL.len());
    }

    #[test]
    fn new_errno_classes_are_named_while_op_axis_still_reports_rename() {
        // A plain-Node ENOENT rename fault: describeError renders
        // `code=ENOENT ENOENT: no such file …, rename …`. The class axis now
        // reports a real ENOENT class instead of OTHER while the op axis keeps
        // reporting rename from the same message.
        let enoent_rename = "code=ENOENT ENOENT: no such file or directory, rename 'a' -> 'b'";
        assert_eq!(
            classify_runner_error_class(enoent_rename),
            RunnerErrorClass::Enoent
        );
        assert_eq!(classify_runner_error_op(enoent_rename), RunnerErrorOp::Rename);
        // The other three new classes classify from their errno substrings.
        assert_eq!(
            classify_runner_error_class("EEXIST: file already exists, mkdir 'x'"),
            RunnerErrorClass::Eexist
        );
        assert_eq!(
            classify_runner_error_class("ENOTEMPTY: directory not empty, rmdir 'x'"),
            RunnerErrorClass::Enotempty
        );
        assert_eq!(
            classify_runner_error_class("EXDEV: cross-device link not permitted, rename 'a' -> 'b'"),
            RunnerErrorClass::Exdev
        );
    }

    #[test]
    fn errno_class_requires_a_bounded_token_not_a_substring_of_a_word() {
        // The new errno class checks match a bounded token, so an errno spelled
        // INSIDE an ordinary word does not misclassify: "preexisting" contains the
        // substring "eexist" but is not an EEXIST fault.
        assert_eq!(
            classify_runner_error_class("failed to load cmp_preexisting entity"),
            RunnerErrorClass::Other
        );
        // A real describeError errno rendering still classifies …
        assert_eq!(
            classify_runner_error_class("code=EEXIST EEXIST: file already exists, mkdir 'x'"),
            RunnerErrorClass::Eexist
        );
        // … including an errno as the bounded token at the end of the message.
        assert_eq!(
            classify_runner_error_class("conflict mirror index write failed: EEXIST"),
            RunnerErrorClass::Eexist
        );
    }

    #[test]
    fn errno_fault_populates_cause_class_op_and_path_axes_together() {
        // record_error drives every axis from the SAME message: an ENOENT rename
        // fault names the enoent cause AND the ENOENT class AND the rename op,
        // with the path root unchanged — the cause and class axes agree.
        let mut totals = RunTotals::default();
        totals.record_error(&SyncErrorEvent {
            company: None,
            path: "knowledge/hq-core/a.md".to_string(),
            message: "code=ENOENT ENOENT: no such file or directory, rename 'a' -> 'b'"
                .to_string(),
        });
        assert_eq!(
            totals.runner_error_rollup.tag_value().as_deref(),
            Some("ENOENT:1")
        );
        assert_eq!(
            totals.runner_error_ops.tag_value().as_deref(),
            Some("rename:1")
        );
        assert_eq!(
            totals.runner_error_causes.tag_value().as_deref(),
            Some("enoent:1")
        );
        assert_eq!(
            totals.runner_error_path_roots.tag_value().as_deref(),
            Some("knowledge:1")
        );
    }

    #[test]
    fn a_new_errno_class_blocks_disk_full_suppression() {
        // A pass with ENOSPC AND a new errno class (ENOENT) is NOT exclusively
        // disk-full: the new class must count as a non-disk-full error, exactly as
        // OTHER did before, so suppression behaviour is unchanged.
        let mut mixed = RunnerErrorRollup::default();
        mixed.record("ENOSPC: no space left on device, write 'x'");
        mixed.record("code=ENOENT ENOENT: no such file, rename 'a' -> 'b'");
        assert!(mixed.has_non_disk_full_error());
        assert!(!mixed.is_exclusively_disk_full());
    }

    #[test]
    fn runner_error_rollup_group_token_is_pinned_for_the_hq_desktop_4t_shape() {
        // The event that motivated this fix: an all-OTHER flood must still group
        // as `other`, and an empty pass as `none`.
        let mut rollup = RunnerErrorRollup::default();
        for _ in 0..7205 {
            rollup.record("download skipped: local parent escaped the sync root");
        }
        assert_eq!(rollup.fingerprint_token(), "other");
        assert_eq!(RunnerErrorRollup::default().fingerprint_token(), "none");
    }

    #[test]
    fn termination_fingerprint_token_is_pinned() {
        // exit:2 is the exact HQ-DESKTOP-4T termination; it must not regroup.
        assert_eq!(termination_fingerprint_token(Some(2), None), "exit:2");
        assert_eq!(termination_fingerprint_token(None, Some(15)), "signal:15");
        assert_eq!(
            termination_fingerprint_token(Some(0), Some(15)),
            "invalid:exit:0+signal:15"
        );
        assert_eq!(termination_fingerprint_token(None, None), "unknown");
    }

    #[test]
    fn exit_disposition_is_pinned_across_the_alert_boundary() {
        // Alertable exit-2 (HQ-DESKTOP-4T) still alerts …
        assert_eq!(
            classify_runner_exit_disposition(Some(2), None, true, true, false),
            RunnerExitDisposition::Alert
        );
        assert!(should_alert_on_nonzero_exit(
            Some(2),
            None,
            true,
            true,
            false
        ));
        // … and a benign exit-2 fully explained by non-alertable errors is still
        // ignored — attribution must not flip either verdict.
        assert_eq!(
            classify_runner_exit_disposition(Some(2), None, true, false, false),
            RunnerExitDisposition::Ignore
        );
        assert!(!should_alert_on_nonzero_exit(
            Some(2),
            None,
            true,
            false,
            false
        ));
        // Node-too-old and transient-retry precedence unchanged.
        assert_eq!(
            classify_runner_exit_disposition(Some(2), None, true, true, true),
            RunnerExitDisposition::NodeTooOld
        );
        assert_eq!(
            classify_runner_exit_disposition(
                Some(RUNNER_TRANSIENT_RETRY_EXIT),
                None,
                false,
                false,
                false
            ),
            RunnerExitDisposition::TransientRetry
        );
        // A concurrent alertable fault still wins over a cancellation record.
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                Some(2),
                None,
                Some(SyncCancelCause::UserStop),
                true,
                true,
                true,
                false,
            ),
            RunnerExitDisposition::Alert
        );
    }

    #[test]
    fn runner_error_scope_splits_company_and_file_without_leaking_paths() {
        let mut totals = RunTotals::default();
        totals.record_error(&SyncErrorEvent {
            company: Some("acme".to_string()),
            path: "(company)".to_string(),
            message: "Entity not found".to_string(),
        });
        for i in 0..3 {
            totals.record_error(&SyncErrorEvent {
                company: Some("acme".to_string()),
                path: format!("knowledge/secret-file-{i}.md"),
                message: "download skipped: local parent escaped the sync root".to_string(),
            });
        }
        assert_eq!(
            totals.runner_error_scope().as_deref(),
            Some("company:1,file:3")
        );
        // The shape + path-root rollups render only fixed tokens, never the seeded
        // path bytes.
        let shapes = totals
            .runner_error_shapes
            .tag_value()
            .expect("shapes present");
        let roots = totals
            .runner_error_path_roots
            .tag_value()
            .expect("roots present");
        // 3 per-file containment escapes + the company-scope "Entity not found"
        // (unknown shape). Path roots exclude the `(company)` sentinel entirely.
        assert_eq!(shapes, "containment_escape:3,unknown:1");
        assert_eq!(roots, "knowledge:3");
        for rendered in [&shapes, &roots] {
            assert!(!rendered.contains("secret-file"));
            assert!(!rendered.contains("acme"));
        }
    }

    #[test]
    fn runner_error_scope_counts_discovery_separately_and_never_path_roots_it() {
        let mut totals = RunTotals::default();
        // A pre-fanout discovery failure: company absent, path is the sentinel.
        totals.record_error(&SyncErrorEvent {
            company: None,
            path: "(discovery)".to_string(),
            message: "Vault unreachable".to_string(),
        });
        totals.record_error(&SyncErrorEvent {
            company: Some("acme".to_string()),
            path: "knowledge/a.md".to_string(),
            message: "download skipped: local parent escaped the sync root".to_string(),
        });
        // Discovery is its own scope, appended after the company/file split, and
        // never counted as a per-file error …
        assert_eq!(
            totals.runner_error_scope().as_deref(),
            Some("company:0,file:1,discovery:1")
        );
        // … and never given a path root ("(discovery)" is not a file path).
        assert_eq!(
            totals.runner_error_path_roots.tag_value().as_deref(),
            Some("knowledge:1")
        );
        // Its message shape is still recorded like any other error.
        assert_eq!(
            totals.runner_error_shapes.tag_value().as_deref(),
            Some("containment_escape:1,unknown:1")
        );
    }

    #[test]
    fn a_named_cause_drives_the_error_class_instead_of_the_keyword_fallback() {
        // The HQ-DESKTOP-4T recurrence: a VaultPermissionDeniedError whose text
        // carries none of the class matcher's keywords collapsed to OTHER on base,
        // so every such exit-2 landed on the one catch-all fingerprint. The cause
        // axis names it, and the bridge now classes it AUTH — for every rendering
        // that actually carries the identifier the cause axis can read.
        for message in [
            // Leading class name (the dominant describeError rendering).
            "VaultPermissionDeniedError permission denied for the company prefix",
            // The identity carried as a `cause=` value behind a plain Error.
            "sync worker failed cause=VaultPermissionDeniedError host=vault",
        ] {
            assert_eq!(
                classify_runner_error_cause(message),
                RunnerErrorCause::VaultPermissionDenied,
                "cause axis must name the fault: {message:?}"
            );
            assert_eq!(
                classify_runner_error_class(message),
                RunnerErrorClass::Auth,
                "a named vault permission denial must class AUTH, not OTHER: {message:?}"
            );
        }

        // The whole permission/authorization family classes AUTH, so none of them
        // can re-form the exit-2 catch-all the keyword matcher left them in.
        for (message, cause) in [
            ("AccessDenied access is denied", RunnerErrorCause::AccessDenied),
            (
                "VendDeniedError the vend was refused",
                RunnerErrorCause::VendDenied,
            ),
            (
                "EntityPermissionError caller lacks permission",
                RunnerErrorCause::EntityPermission,
            ),
        ] {
            assert_eq!(classify_runner_error_cause(message), cause, "{message:?}");
            assert_eq!(
                classify_runner_error_class(message),
                RunnerErrorClass::Auth,
                "permission/authorization family must class AUTH: {message:?}"
            );
        }

        // A named DNS/transport fault the keyword matcher omits (ENOTFOUND is not
        // in is_transient_network_error) now classes NETWORK through the cause.
        assert_eq!(
            classify_runner_error_class("ENOTFOUND: getaddrinfo failed for the vault host"),
            RunnerErrorClass::Network
        );
    }

    #[test]
    fn an_unnamed_message_still_uses_the_keyword_classifier_unchanged() {
        // The bridge fires ONLY for a positively-named cause. An unnamed message
        // is classified exactly as before, so nothing the keyword matcher already
        // handled changes.

        // Pure pull-leg prose with no identity: unnamed on the cause axis, so the
        // bridge yields None and the keyword matcher decides — OTHER, as today.
        let prose = "download skipped: local parent escaped the sync root";
        assert_eq!(
            classify_runner_error_cause(prose),
            RunnerErrorCause::UnknownUnnamed
        );
        assert_eq!(classify_runner_error_class(prose), RunnerErrorClass::Other);

        // Content-safety boundary: a permission denial rendered as PROSE ONLY —
        // no class name, no code — has no content-safe identity to key on, so it
        // is NOT bridged to AUTH. Naming it would require reading free prose.
        assert_eq!(
            classify_runner_error_class("access to the company prefix was denied"),
            RunnerErrorClass::Other
        );

        // The keyword matcher still owns every class it already decided: an EPERM
        // rename (the bridge agrees), a transient-network "socket hang up" the
        // cause axis cannot name, and a bare auth marker.
        assert_eq!(
            classify_runner_error_class("EPERM: operation not permitted, rename 'a.hq-tmp' -> 'a'"),
            RunnerErrorClass::Eperm
        );
        assert_eq!(
            classify_runner_error_class("upload failed: socket hang up"),
            RunnerErrorClass::Network
        );
        assert_eq!(
            classify_runner_error_class("Unauthorized: cognito rejected the request"),
            RunnerErrorClass::Auth
        );
    }

    #[test]
    fn every_runner_error_cause_has_a_deliberate_class_decision() {
        use RunnerErrorCause as C;
        // Every deliberate NON-None decision, spelled out so a wrong remap or an
        // unreviewed future variant fails here. The match in class_for_named_cause
        // is already exhaustive (a missing variant is a compile error); this table
        // additionally pins WHICH class each mapped cause chose, and asserts every
        // other variant keeps the keyword fallback (None).
        let auth = [
            C::EntityPermission,
            C::VaultPermissionDenied,
            C::VendDenied,
            C::AccessDenied,
            C::VaultIdentity,
            C::CognitoIdentity,
            C::CognitoIdentityRefresh,
            C::ExpiredIdentity,
            C::InvalidIdentity,
        ];
        let network = [
            C::Econnreset,
            C::Econnrefused,
            C::Etimedout,
            C::Epipe,
            C::EaiAgain,
            C::Enetdown,
            C::Enetunreach,
            C::Ehostunreach,
            C::Enotfound,
        ];
        let errno_class = [
            (C::Eperm, RunnerErrorClass::Eperm),
            (C::Eacces, RunnerErrorClass::Eacces),
            (C::Enospc, RunnerErrorClass::Enospc),
            (C::Ebusy, RunnerErrorClass::Ebusy),
            (C::Enoent, RunnerErrorClass::Enoent),
            (C::Eexist, RunnerErrorClass::Eexist),
            (C::Enotempty, RunnerErrorClass::Enotempty),
            (C::Exdev, RunnerErrorClass::Exdev),
        ];
        for cause in auth {
            assert_eq!(
                class_for_named_cause(cause),
                Some(RunnerErrorClass::Auth),
                "{cause:?} must bridge to AUTH"
            );
        }
        for cause in network {
            assert_eq!(
                class_for_named_cause(cause),
                Some(RunnerErrorClass::Network),
                "{cause:?} must bridge to NETWORK"
            );
        }
        for (cause, class) in errno_class {
            assert_eq!(class_for_named_cause(cause), Some(class), "{cause:?}");
        }
        let is_mapped = |c: RunnerErrorCause| {
            auth.contains(&c) || network.contains(&c) || errno_class.iter().any(|(mc, _)| *mc == c)
        };
        let mut mapped = 0;
        for cause in RunnerErrorCause::ALL {
            if is_mapped(cause) {
                mapped += 1;
            } else {
                assert_eq!(
                    class_for_named_cause(cause),
                    None,
                    "{cause:?} must keep the keyword fallback (None)"
                );
            }
        }
        assert_eq!(
            mapped, 26,
            "exactly 26 causes bridge to a class; every other variant stays None"
        );
    }

    #[test]
    fn record_error_populates_new_axes_across_scopes_without_perturbing_existing_ones() {
        let mut totals = RunTotals::default();
        // Company-scope describeError carrying an `http=` status, an AWS name, and
        // a secret-looking `host=` that must never surface on any axis.
        totals.record_error(&SyncErrorEvent {
            company: Some("acme".to_string()),
            path: "(company)".to_string(),
            message:
                "AccessDenied http=403 host=hq-vault-cmp-acme-9f3.s3.us-east-1.amazonaws.com denied"
                    .to_string(),
        });
        // Per-file presigned failures carrying the status in the `: <status>` tail.
        for i in 0..3 {
            totals.record_error(&SyncErrorEvent {
                company: Some("acme".to_string()),
                path: format!("knowledge/secret-{i}.md"),
                message: format!("presigned GET failed for knowledge/secret-{i}.md: 500 "),
            });
        }
        // A pre-fanout discovery describeError with its own `http=` status + name.
        totals.record_error(&SyncErrorEvent {
            company: None,
            path: "(discovery)".to_string(),
            message: "InternalError http=500 we encountered an internal error".to_string(),
        });

        // New axes are populated for company-, per-file-, and discovery-scope
        // errors alike — the company-scope path is precisely the one that yielded
        // nothing before this change.
        assert_eq!(
            totals.runner_error_http.tag_value().as_deref(),
            Some("http_500:4,http_403:1")
        );
        assert_eq!(
            totals.runner_error_causes.tag_value().as_deref(),
            Some("unknown_unnamed:3,access_denied:1,internal_error:1")
        );
        // No unlisted (uppercase-initial, unmatched) identity appeared: AccessDenied
        // and InternalError are named, the presigned prose is unnamed — so the
        // signature axis attaches no tag.
        assert_eq!(totals.runner_error_cause_signature.tag_value(), None);

        // The scope, shape, path-root, and op axes are byte-identical to their
        // pre-change values for the same inputs — the cause bridge perturbs none
        // of them.
        assert_eq!(
            totals.runner_error_scope().as_deref(),
            Some("company:1,file:3,discovery:1")
        );
        assert_eq!(
            totals.runner_error_shapes.tag_value().as_deref(),
            Some("presigned_get_failed:3,unknown:2")
        );
        assert_eq!(
            totals.runner_error_path_roots.tag_value().as_deref(),
            Some("knowledge:3")
        );
        // The CLASS rollup now names the AccessDenied company-scope record AUTH
        // via the r3 cause→class bridge — its text carries none of the keyword
        // markers the class matcher looks for, so before this fix it collapsed to
        // OTHER. The four unnamed presigned/InternalError records stay OTHER, and
        // the dominant-by-count fingerprint token is unchanged (OTHER, 4 > 1).
        assert_eq!(
            totals.runner_error_rollup.tag_value().as_deref(),
            Some("AUTH:1,OTHER:4")
        );
        assert_eq!(totals.runner_error_ops.tag_value().as_deref(), Some("other:5"));
        assert_eq!(totals.runner_error_rollup.fingerprint_token(), "other");
        assert!(totals.saw_alertable_error);

        // Content safety: the rendered new-axis tags carry no host or path byte.
        for rendered in [
            totals.runner_error_http.tag_value().unwrap(),
            totals.runner_error_causes.tag_value().unwrap(),
        ] {
            for fragment in ["hq-vault", "acme", "9f3", "amazonaws", "secret-"] {
                assert!(
                    !rendered.contains(fragment),
                    "new-axis tag leaked {fragment:?}: {rendered}"
                );
            }
        }
    }

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
    fn describe_exit_names_every_signal_only_shape_the_watcher_fallback_reaches() {
        // The watcher-exit fallback now routes signal-only terminations through
        // this renderer instead of a raw Debug tuple, so pin the exact strings —
        // SIGHUP being the one HQ-DESKTOP-5Y observed as `code=None signal=Some(1)`.
        assert_eq!(describe_exit(None, Some(SIGHUP_SIGNAL)), "killed by SIGHUP");
        assert_eq!(describe_exit(None, Some(SIGINT_SIGNAL)), "killed by SIGINT");
        assert_eq!(
            describe_exit(None, Some(SIGKILL_SIGNAL)),
            "killed by SIGKILL (likely OOM or force-quit)"
        );
        assert_eq!(
            describe_exit(None, Some(SIGSEGV_SIGNAL)),
            "crashed with SIGSEGV (segfault)"
        );
        assert_eq!(
            describe_exit(None, Some(SIGBUS_SIGNAL_MACOS)),
            "crashed with SIGBUS"
        );
        assert_eq!(
            describe_exit(None, Some(SIGABRT_SIGNAL)),
            "aborted with SIGABRT"
        );
        assert_eq!(
            describe_exit(None, Some(SIGTERM_SIGNAL)),
            "killed by SIGTERM (cancelled)"
        );
        // An unmapped signal still names itself rather than leaking a raw tuple.
        assert_eq!(describe_exit(None, Some(31)), "killed by signal 31");
    }

    #[test]
    fn watcher_exit_signal_class_is_a_closed_vocabulary() {
        // A signal-free exit is `none`; SIGHUP is `hangup`.
        assert_eq!(watcher_exit_signal_class(None), "none");
        assert_eq!(watcher_exit_signal_class(Some(SIGHUP_SIGNAL)), "hangup");
        assert_eq!(watcher_exit_signal_class(Some(SIGINT_SIGNAL)), "interrupt");
        assert_eq!(watcher_exit_signal_class(Some(SIGTERM_SIGNAL)), "cancel");

        // Exhaustive over the POSIX signal range: every signal maps to exactly one
        // of the six fixed tokens, and the `fault` arm is byte-for-byte the
        // `is_crash_signal` set (so the two can never drift).
        const VOCAB: [&str; 6] = ["fault", "cancel", "hangup", "interrupt", "other", "none"];
        for sig in 1..=31 {
            let class = watcher_exit_signal_class(Some(sig));
            assert!(
                VOCAB.contains(&class),
                "signal {sig} produced out-of-vocabulary class {class}"
            );
            assert_eq!(
                class == "fault",
                is_crash_signal(Some(sig)),
                "fault-arm drift from is_crash_signal at signal {sig}"
            );
        }
    }

    #[test]
    fn watcher_fingerprint_tokens_are_unchanged_across_the_shape_matrix() {
        // This fix is reporting-only: it changes the message text, never the
        // fingerprint. Pin the three fingerprint helpers for the full shape matrix
        // so a grouping regression fails loudly. SIGHUP stays `signal:1`.
        let none = MemoryExhaustionEvidence::default();
        let cases: [(Option<i32>, Option<i32>, &str); 6] = [
            (None, Some(SIGHUP_SIGNAL), "signal:1"),
            (None, Some(SIGKILL_SIGNAL), "signal:9"),
            (Some(221), None, "exit:221"),
            (Some(0xC000_0409u32 as i32), None, "windows:fault:0xC0000409"),
            (Some(3), Some(9), "invalid:exit:3+signal:9"),
            (None, None, "unknown"),
        ];
        for (code, signal, token) in cases {
            assert_eq!(termination_fingerprint_token(code, signal), token);
            // With no memory evidence the watcher token is exactly the host token.
            assert_eq!(
                watcher_termination_fingerprint_token(
                    code,
                    signal,
                    TerminationHost::Posix,
                    none
                ),
                termination_fingerprint_token_for_host(code, signal, TerminationHost::Posix)
            );
        }
        // SIGABRT is the one shape normalized away from its raw signal token, on
        // BOTH hosts — pinned so the fix does not disturb that convergence.
        assert_eq!(
            termination_fingerprint_token_for_host(None, Some(SIGABRT_SIGNAL), TerminationHost::Posix),
            "abort:sigabrt"
        );
        assert_eq!(
            termination_fingerprint_token_for_host(
                Some(NODE_WINDOWS_ABORT_EXIT),
                None,
                TerminationHost::Windows
            ),
            "abort:sigabrt"
        );
        // SIGHUP is NOT normalized: its host token is its raw signal token.
        assert_eq!(
            termination_fingerprint_token_for_host(None, Some(SIGHUP_SIGNAL), TerminationHost::Posix),
            "signal:1"
        );
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
    fn normalized_abort_fingerprints_join_only_the_observed_host_encodings() {
        for (code, signal, host) in [
            (
                Some(NODE_WINDOWS_ABORT_EXIT),
                None,
                TerminationHost::Windows,
            ),
            (None, Some(SIGABRT_SIGNAL), TerminationHost::Posix),
            (None, Some(SIGABRT_SIGNAL), TerminationHost::Windows),
        ] {
            assert_eq!(
                termination_fingerprint_token_for_host(code, signal, host),
                "abort:sigabrt"
            );
        }

        assert_eq!(
            termination_fingerprint_token_for_host(
                Some(NODE_WINDOWS_ABORT_EXIT),
                None,
                TerminationHost::Posix,
            ),
            "exit:134"
        );
    }

    #[test]
    fn normalized_abort_descriptions_are_exact_and_host_scoped() {
        assert_eq!(
            normalized_abort_description(None, Some(SIGABRT_SIGNAL), TerminationHost::Posix),
            Some("aborted with SIGABRT")
        );
        assert_eq!(
            normalized_abort_description(None, Some(SIGABRT_SIGNAL), TerminationHost::Windows),
            Some("aborted with SIGABRT")
        );
        assert_eq!(
            normalized_abort_description(
                Some(NODE_WINDOWS_ABORT_EXIT),
                None,
                TerminationHost::Windows,
            ),
            Some("aborted (Node abort exit code 134)")
        );

        for (code, signal, host) in [
            (Some(NODE_WINDOWS_ABORT_EXIT), None, TerminationHost::Posix),
            (
                Some(NODE_WINDOWS_ABORT_EXIT),
                Some(SIGABRT_SIGNAL),
                TerminationHost::Windows,
            ),
            (None, None, TerminationHost::Posix),
            (Some(221), None, TerminationHost::Windows),
        ] {
            assert_eq!(normalized_abort_description(code, signal, host), None);
        }
    }

    #[test]
    fn non_abort_host_tokens_delegate_byte_for_byte_to_the_base_contract() {
        let cases = [
            (Some(0), None, "exit:0"),
            (Some(1), None, "exit:1"),
            (Some(2), None, "exit:2"),
            (Some(126), None, "exit:126"),
            (Some(127), None, "exit:127"),
            (Some(221), None, "exit:221"),
            (
                Some(WINDOWS_CONTROL_C_EXIT),
                None,
                "windows:console-control",
            ),
            (
                Some(WINDOWS_SESSION_TERMINATE_EXIT),
                None,
                "windows:session-terminate",
            ),
            (
                Some(0xC000_0409u32 as i32),
                None,
                "windows:fault:0xC0000409",
            ),
            (Some(2), Some(2), "invalid:exit:2+signal:2"),
            (None, None, "unknown"),
        ];

        for host in [TerminationHost::Posix, TerminationHost::Windows] {
            for (code, signal, expected) in cases {
                assert_eq!(
                    termination_fingerprint_token_for_host(code, signal, host),
                    expected
                );
                assert_eq!(
                    termination_fingerprint_token_for_host(code, signal, host),
                    termination_fingerprint_token(code, signal)
                );
            }
        }
    }

    #[test]
    fn memory_evidence_is_attributed_only_with_a_source() {
        assert!(!MemoryExhaustionEvidence::default().is_attributed());
        assert!(MemoryExhaustionEvidence {
            heap_oom_class: true,
            ..Default::default()
        }
        .is_attributed());
        assert!(MemoryExhaustionEvidence {
            footprint_at_or_above_ceiling: true,
            ..Default::default()
        }
        .is_attributed());
        assert!(MemoryExhaustionEvidence {
            supervisor_preempt: true,
            ..Default::default()
        }
        .is_attributed());
    }

    #[test]
    fn watcher_memory_token_converges_the_three_host_encodings_when_evidenced() {
        // The three deaths in this cluster (a SIGKILL, a SIGABRT heap abort, and a
        // Windows fault) each carry a DISTINCT host token before convergence.
        let encodings = [
            (None, Some(9), TerminationHost::Posix, "signal:9"),
            (
                None,
                Some(SIGABRT_SIGNAL),
                TerminationHost::Posix,
                "abort:sigabrt",
            ),
            (
                Some(0xC000_0409u32 as i32),
                None,
                TerminationHost::Windows,
                "windows:fault:0xC0000409",
            ),
        ];
        // Each evidence source, on its own, collapses every encoding to one token.
        let evidences = [
            MemoryExhaustionEvidence {
                heap_oom_class: true,
                ..Default::default()
            },
            MemoryExhaustionEvidence {
                footprint_at_or_above_ceiling: true,
                ..Default::default()
            },
            MemoryExhaustionEvidence {
                supervisor_preempt: true,
                ..Default::default()
            },
        ];
        for (code, signal, host, raw) in encodings {
            // Sanity: the pre-convergence token really is the distinct host token.
            assert_eq!(
                termination_fingerprint_token_for_host(code, signal, host),
                raw
            );
            for evidence in evidences {
                assert_eq!(
                    watcher_termination_fingerprint_token(code, signal, host, evidence),
                    RUNNER_MEMORY_EXHAUSTION_TOKEN,
                    "evidenced {raw} must converge on the memory token"
                );
            }
        }
    }

    #[test]
    fn watcher_memory_token_preserves_evidence_free_terminations_byte_for_byte() {
        // With NO memory evidence the gated token equals today's host token exactly,
        // so a force-quit is never relabelled an OOM and unrelated exits never
        // regroup. A bare SIGKILL stays signal:9.
        let none = MemoryExhaustionEvidence::default();
        for host in [TerminationHost::Posix, TerminationHost::Windows] {
            for (code, signal) in [
                (None, Some(9)),
                (None, Some(15)),
                (Some(1), None),
                (Some(0xC000_0409u32 as i32), None),
                (None, Some(SIGABRT_SIGNAL)),
                (None, None),
            ] {
                assert_eq!(
                    watcher_termination_fingerprint_token(code, signal, host, none),
                    termination_fingerprint_token_for_host(code, signal, host)
                );
            }
        }
        // The named example the cluster owes: an evidence-free SIGKILL stays signal:9.
        assert_eq!(
            watcher_termination_fingerprint_token(None, Some(9), TerminationHost::Posix, none),
            "signal:9"
        );
    }

    #[test]
    fn current_termination_host_matches_the_build_target() {
        let expected = if cfg!(target_os = "windows") {
            TerminationHost::Windows
        } else {
            TerminationHost::Posix
        };
        assert_eq!(current_termination_host(), expected);
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
        SyncAllCompleteEvent, SyncAuthErrorEvent, SyncCompleteEvent, SyncMaintenanceProgressEvent,
        SyncProgressEvent,
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
    fn npm_relay_stderr_classifies_as_npm_install_relay_and_never_exec() {
        let home_path = "/Users/ada/.npm/_npx/f72697f8e89f117e/node_modules/.bin/hq-sync-runner";
        // npm relays a failing lifecycle status while printing only its OWN
        // `npm error …` lines. These attribute to the npm relay — including an
        // ENOENT under `_npx`, which the shell-exec `/.npm/_npx/` marker would
        // otherwise mislabel exec_not_found (the reorder-before-exec-arms fix).
        let enoent_under_npx =
            format!("npm error enoent ENOENT: no such file or directory, open '{home_path}'");
        let npm_lines = [
            "npm error code ELIFECYCLE".to_string(),
            "npm error errno 190".to_string(),
            "npm error command failed".to_string(),
            "npm error command sh -c hq-sync-runner --watch".to_string(),
            enoent_under_npx.clone(),
            "npm ERR! code E190".to_string(),
            "  npm error path /Users/ada/.npm/_npx/f72697f8e89f117e".to_string(),
        ];
        for npm_line in &npm_lines {
            assert_eq!(
                classify_runner_fatal_class(npm_line),
                RunnerFatalClass::NpmInstallRelay,
                "npm own-prefixed line must attribute to the npm relay: {npm_line:?}"
            );
        }

        // Fixed constant — no observed bytes, no path or username fragment.
        let token = classify_runner_fatal_class(&enoent_under_npx).as_str();
        assert_eq!(token, "npm_install_relay");
        assert!(!token.contains("ada"));
        assert!(!token.contains("_npx"));
        assert!(!token.contains('/'));

        // Only npm-prefixed lines change class relative to base: the shell-exec
        // legs this cluster's fix actually addresses stay exactly as they were.
        assert_eq!(
            classify_runner_fatal_class(&format!("sh: {home_path}: Permission denied")),
            RunnerFatalClass::ExecPermissionDenied
        );
        assert_eq!(
            classify_runner_fatal_class(&format!("sh: {home_path}: No such file or directory")),
            RunnerFatalClass::ExecNotFound
        );
        assert_eq!(
            classify_runner_fatal_class("bash: hq-sync-runner: command not found"),
            RunnerFatalClass::ExecNotFound
        );
        assert_eq!(
            classify_runner_fatal_class("zsh: hq-sync-runner: permission denied"),
            RunnerFatalClass::ExecPermissionDenied
        );
        // A bare node_modules/.bin marker line (no npm/shell own-prefix) keeps its
        // base class — it is not npm-prefixed, so it must not change.
        assert_eq!(
            classify_runner_fatal_class("node_modules/.bin/hq-sync-runner: No such file or directory"),
            RunnerFatalClass::ExecNotFound
        );
    }

    #[test]
    fn libuv_fatal_syscall_is_classified_with_allow_listed_syscall_and_integer_errno() {
        // The exact live-event shape (HQ-DESKTOP-4X) that classified to `none`.
        let signature =
            classify_runner_fatal_signature("ReadDirectoryChangesW: (5) Access is denied.");
        assert_eq!(signature.class, RunnerFatalClass::LibuvFatalSyscall);
        assert_eq!(signature.syscall, Some("ReadDirectoryChangesW"));
        assert_eq!(signature.errno, Some(5));
        assert_eq!(signature.class.as_str(), "libuv_fatal_syscall");
        // Case-insensitive identifier match still yields the canonical constant.
        let lowercased = classify_runner_fatal_signature("readdirectorychangesw: (5) x");
        assert_eq!(lowercased.syscall, Some("ReadDirectoryChangesW"));

        // Near-misses all stay None — no parentheses, non-integer errno, unknown
        // leading identifier, and an ordinary message with a colon and a number.
        for near_miss in [
            "ReadDirectoryChangesW: 5 Access is denied.",
            "ReadDirectoryChangesW: (five) Access is denied.",
            "TotallyMadeUpSyscall: (5) Access is denied.",
            "Progress: 5 files copied",
            "",
        ] {
            assert_eq!(
                classify_runner_fatal_class(near_miss),
                RunnerFatalClass::None,
                "near-miss must stay None: {near_miss:?}"
            );
        }
    }

    #[test]
    fn libuv_fatal_syscall_shape_maps_unknown_identifiers_to_the_other_constant() {
        // Defensive content-safety: even if the shape parses with an unknown
        // identifier, the parser reports the fixed constant `other`, never the
        // observed word — and the class still refuses to classify it.
        let (token, errno) =
            parse_libuv_fatal_syscall("SecretInternalCall: (13) /Users/ada/private")
                .expect("shape parses");
        assert_eq!(token, "other");
        assert_eq!(errno, 13);
        assert!(!is_libuv_fatal_syscall_line(
            "SecretInternalCall: (13) /Users/ada/private"
        ));
        assert!(!token.contains("Secret"));
    }

    #[test]
    fn widened_libuv_assert_arm_covers_libuv_sources_but_not_generic_paths() {
        // Node's bundled libuv prints its vendor path (`deps/uv/`) for every
        // source, so fs-event.c / pipe.c / core.c assertions still classify —
        // and the back-compat `src\win\async.c` marker is preserved.
        for libuv_source in [
            r"Assertion failed: ..., file c:\ws\deps\uv\src\win\fs-event.c, line 480",
            "Assertion failed: cond, file deps/uv/src/unix/core.c, line 12",
            r"Assertion failed: cond, file ..\deps\uv\src\win\pipe.c, line 7",
            r"Assertion failed: cond, file src\win\async.c, line 1",
        ] {
            assert_eq!(
                classify_runner_fatal_class(libuv_source),
                RunnerFatalClass::LibuvAssert,
                "libuv-source assertion must classify as libuv_assert: {libuv_source:?}"
            );
        }
        // A generic src\win\ / src/unix/ path with no unambiguous libuv marker
        // must NOT be mislabeled libuv_assert (other trees are organised the same
        // way), and a bare application assertion still stays None.
        for non_libuv in [
            r"Assertion failed: cond, file src\win\pipe.c, line 7",
            "Assertion failed: cond, file src/unix/fs.c, line 3",
            "Assertion failed: !(n > 0) || (ret != nullptr)",
        ] {
            assert_eq!(
                classify_runner_fatal_class(non_libuv),
                RunnerFatalClass::None,
                "a non-libuv assertion must stay None: {non_libuv:?}"
            );
        }
    }

    #[test]
    fn previously_classified_fixtures_keep_their_class_after_the_new_arm() {
        // Every arm that already classified must be unaffected by the new,
        // last-position libuv-fatal-syscall arm.
        for (line, expected) in [
            (
                "TypeError: diagnostics_channel.tracingChannel is not a function",
                RunnerFatalClass::NodeTooOld,
            ),
            (
                r"Assertion failed: cond, file src\win\async.c, line 76",
                RunnerFatalClass::LibuvAssert,
            ),
            (
                "  #  Assertion failed: !(n > 0) || (ret != nullptr)",
                RunnerFatalClass::NodeCheckAbort,
            ),
            (
                "FATAL ERROR: JavaScript heap out of memory",
                RunnerFatalClass::HeapOom,
            ),
            (
                "thread 'main' panicked at 'boom'",
                RunnerFatalClass::RustPanic,
            ),
            ("uncaught exception: boom", RunnerFatalClass::NodeFatal),
            (
                "sh: hq-sync-runner: Permission denied",
                RunnerFatalClass::ExecPermissionDenied,
            ),
            (
                "sh: hq-sync-runner: command not found",
                RunnerFatalClass::ExecNotFound,
            ),
        ] {
            assert_eq!(
                classify_runner_fatal_class(line),
                expected,
                "fixture changed class: {line:?}"
            );
        }
    }

    #[test]
    fn record_stderr_line_moves_class_syscall_and_errno_in_lockstep() {
        let mut totals = RunTotals::default();
        totals.record_stderr_line("ReadDirectoryChangesW: (5) Access is denied.");
        totals.record_stderr_line("    at fs.watch (node:fs:1:1)");
        // A later unclassified continuation line never clears the winning line.
        assert_eq!(totals.runner_fatal_class, RunnerFatalClass::LibuvFatalSyscall);
        assert_eq!(totals.runner_fatal_syscall(), Some("ReadDirectoryChangesW"));
        assert_eq!(totals.runner_fatal_errno(), Some(5));

        // A later, different libuv-fatal line wins as a whole triple.
        totals.record_stderr_line("CreateIoCompletionPort: (1450) Insufficient resources.");
        assert_eq!(totals.runner_fatal_class, RunnerFatalClass::LibuvFatalSyscall);
        assert_eq!(totals.runner_fatal_syscall(), Some("CreateIoCompletionPort"));
        assert_eq!(totals.runner_fatal_errno(), Some(1450));

        // A non-libuv fatal class leaves syscall/errno cleared for that line.
        let mut assert_totals = RunTotals::default();
        assert_totals.record_stderr_line(r"Assertion failed: cond, file src\win\async.c, line 1");
        assert_eq!(assert_totals.runner_fatal_class, RunnerFatalClass::LibuvAssert);
        assert_eq!(assert_totals.runner_fatal_syscall(), None);
        assert_eq!(assert_totals.runner_fatal_errno(), None);
    }

    #[test]
    fn runner_fatal_class_all_enumerates_a_fixed_content_safe_vocabulary() {
        // The emitter's own vocabulary, so this content-safety guard cannot drift
        // out of date and automatically covers the new variant.
        let mut seen = std::collections::HashSet::new();
        for class in RunnerFatalClass::ALL {
            let token = class.as_str();
            assert!(
                !token.is_empty()
                    && token
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b == b'_'),
                "fatal-class token must be a fixed lower_snake constant: {token:?}"
            );
            assert!(seen.insert(token), "duplicate fatal-class token: {token:?}");
        }
        assert!(seen.contains("libuv_fatal_syscall"));
        assert_eq!(seen.len(), RunnerFatalClass::ALL.len());
    }

    #[test]
    fn node_check_abort_classifier_requires_the_observed_assertion_line_shape() {
        let companion = r"  #  C:\WINDOWS\system32\cmd.exe [44452]: char *__cdecl node::Realloc<char>(char *,unsigned __int64) at c:\ws\src\util-inl.h:378";
        let assertion = "  #  Assertion failed: !(n > 0) || (ret != nullptr)";

        assert_eq!(
            classify_runner_fatal_class(assertion),
            RunnerFatalClass::NodeCheckAbort
        );
        assert_eq!(
            classify_runner_fatal_class(companion),
            RunnerFatalClass::None
        );
        assert_eq!(
            classify_runner_fatal_class(
                "# Assertion failed: loop != nullptr, src\\\\win\\\\async.c libuv"
            ),
            RunnerFatalClass::LibuvAssert
        );
        assert_eq!(
            classify_runner_fatal_class("Assertion failed: !(n > 0) || (ret != nullptr)"),
            RunnerFatalClass::None
        );
        assert_eq!(
            RunnerFatalClass::NodeCheckAbort.as_str(),
            "node_check_abort"
        );
    }

    #[test]
    fn node_check_abort_stderr_rollup_is_sticky_across_the_observed_pair() {
        let companion = r"  #  C:\WINDOWS\system32\cmd.exe [44452]: char *__cdecl node::Realloc<char>(char *,unsigned __int64) at c:\ws\src\util-inl.h:378";
        let assertion = "  #  Assertion failed: !(n > 0) || (ret != nullptr)";

        let mut companion_then_assertion = RunTotals::default();
        for line in [companion, assertion, "", "    at journal.js:1:1"] {
            companion_then_assertion.record_stderr_line(line);
        }
        assert_eq!(
            companion_then_assertion.runner_fatal_class,
            RunnerFatalClass::NodeCheckAbort
        );

        let mut assertion_then_companion = RunTotals::default();
        for line in [assertion, companion, ""] {
            assertion_then_companion.record_stderr_line(line);
        }
        assert_eq!(
            assertion_then_companion.runner_fatal_class,
            RunnerFatalClass::NodeCheckAbort
        );

        let mut companion_only = RunTotals::default();
        companion_only.record_stderr_line(companion);
        assert_eq!(companion_only.runner_fatal_class, RunnerFatalClass::None);
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
    fn test_accumulate_ignores_maintenance_progress() {
        let mut t = RunTotals::default();
        t.accumulate(&SyncEvent::MaintenanceProgress(
            SyncMaintenanceProgressEvent {
                company: "indigo".to_string(),
                bytes_processed: 128 * 1024 * 1024,
                total_bytes: 2_153_544_154,
            },
        ));
        assert_eq!(t, RunTotals::default());
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
    fn effective_app_cancellation_is_suppressed_only_for_its_own_exit_shape() {
        let (owned_code, owned_signal) = match current_termination_host() {
            TerminationHost::Windows => (Some(1), None),
            TerminationHost::Posix => (None, Some(SIGTERM_SIGNAL)),
        };
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                owned_code,
                owned_signal,
                Some(SyncCancelCause::TimeoutWatchdog),
                true,
                false,
                false,
                false,
            ),
            RunnerExitDisposition::CancelledByApp(SyncCancelCause::TimeoutWatchdog),
        );

        // An attempted cancellation is not evidence that it terminated the
        // runner. A later real failure must stay loud.
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                Some(1),
                None,
                Some(SyncCancelCause::UserStop),
                false,
                false,
                false,
                false,
            ),
            RunnerExitDisposition::Alert,
        );

        // The alertable runner fault wins even when our termination also
        // succeeded; this preserves the EPERM class in the reported issue.
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                Some(1),
                None,
                Some(SyncCancelCause::AppQuit),
                true,
                true,
                true,
                false,
            ),
            RunnerExitDisposition::Alert,
        );

        // A natural non-zero exit racing a cancellation is not attributable to
        // the application solely because a cancellation record exists.
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                Some(2),
                None,
                Some(SyncCancelCause::TimeoutWatchdog),
                true,
                false,
                false,
                false,
            ),
            RunnerExitDisposition::Alert,
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn code_one_is_not_an_app_termination_shape_on_posix() {
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                Some(1),
                None,
                Some(SyncCancelCause::TimeoutWatchdog),
                true,
                false,
                false,
                false,
            ),
            RunnerExitDisposition::Alert,
        );
    }

    #[test]
    fn watcher_boundary_helper_attributes_only_through_all_four_gates() {
        let (owned_code, owned_signal) = match current_termination_host() {
            TerminationHost::Windows => (Some(1), None),
            TerminationHost::Posix => (None, Some(SIGKILL_SIGNAL)),
        };

        // All four gates satisfied: a heartbeat-stall teardown SIGKILL that the
        // app observed take effect, with no alertable runner error — attributed.
        assert!(watcher_exit_attributed_to_app_teardown(
            owned_code,
            owned_signal,
            Some(SyncCancelCause::HeartbeatStall),
            true,
            false,
        ));
        // SIGTERM shape is equally an app-termination shape on POSIX.
        let sigterm_shape = matches!(current_termination_host(), TerminationHost::Posix);
        if sigterm_shape {
            assert!(watcher_exit_attributed_to_app_teardown(
                None,
                Some(SIGTERM_SIGNAL),
                Some(SyncCancelCause::HeartbeatStall),
                true,
                false,
            ));
        }

        // Gate 1 — no recorded cause (an external kill with no app cancellation).
        assert!(!watcher_exit_attributed_to_app_teardown(
            owned_code,
            owned_signal,
            None,
            true,
            false,
        ));
        // Gate 2 — cause recorded but termination not observed (ESRCH / lost /
        // timed-out publication). This is the invariant that keeps external kills
        // alertable, so it must never be weakened.
        assert!(!watcher_exit_attributed_to_app_teardown(
            owned_code,
            owned_signal,
            Some(SyncCancelCause::HeartbeatStall),
            false,
            false,
        ));
        // Gate 3 — wrong exit shape. Both of these are an app-termination shape
        // on NEITHER host: POSIX wants (code=None, signal in {15,9}) and Windows
        // wants (code=1, signal=None), so a crash signal or a plain non-1 exit
        // code never attributes regardless of platform.
        assert!(!watcher_exit_attributed_to_app_teardown(
            None,
            Some(6), // SIGABRT
            Some(SyncCancelCause::HeartbeatStall),
            true,
            false,
        ));
        assert!(!watcher_exit_attributed_to_app_teardown(
            Some(2), // plain non-zero exit code — not code 1, so not the Windows shape
            None,
            Some(SyncCancelCause::HeartbeatStall),
            true,
            false,
        ));
        // Gate 4 — a concurrent alertable runner error wins over attribution.
        assert!(!watcher_exit_attributed_to_app_teardown(
            owned_code,
            owned_signal,
            Some(SyncCancelCause::HeartbeatStall),
            true,
            true,
        ));
    }

    #[test]
    fn watcher_boundary_matches_full_classifier_over_the_lattice() {
        // The reduced-input boundary helper must agree with the full manual-sync
        // classifier's `CancelledByApp` projection for EVERY combination of
        // `saw_error` and `saw_node_too_old` — proving those two inputs cannot
        // change an attribution verdict, which is what justifies omitting them.
        let shapes: [(Option<i32>, Option<i32>); 7] = [
            (None, Some(SIGTERM_SIGNAL)),
            (None, Some(SIGKILL_SIGNAL)),
            (None, Some(6)),
            (Some(1), None),
            (Some(0), None),
            (Some(2), None),
            (None, None),
        ];
        let causes = [
            None,
            Some(SyncCancelCause::HeartbeatStall),
            Some(SyncCancelCause::UserStop),
            Some(SyncCancelCause::TimeoutWatchdog),
            Some(SyncCancelCause::AppQuit),
        ];
        for (code, signal) in shapes {
            for cause in causes {
                for termination_effected in [false, true] {
                    for saw_error in [false, true] {
                        for saw_alertable_error in [false, true] {
                            for saw_node_too_old in [false, true] {
                                let full = matches!(
                                    classify_runner_exit_disposition_with_cancellation(
                                        code,
                                        signal,
                                        cause,
                                        termination_effected,
                                        saw_error,
                                        saw_alertable_error,
                                        saw_node_too_old,
                                    ),
                                    RunnerExitDisposition::CancelledByApp(_)
                                );
                                let boundary = watcher_exit_attributed_to_app_teardown(
                                    code,
                                    signal,
                                    cause,
                                    termination_effected,
                                    saw_alertable_error,
                                );
                                assert_eq!(
                                    boundary, full,
                                    "boundary/classifier disagree for code={code:?} signal={signal:?} cause={cause:?} effected={termination_effected} saw_error={saw_error} saw_alertable={saw_alertable_error} saw_node={saw_node_too_old}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn cancellation_classifier_preserves_legacy_policy_outside_exact_effective_stops() {
        let (owned_code, owned_signal) = match current_termination_host() {
            TerminationHost::Windows => (Some(1), None),
            TerminationHost::Posix => (None, Some(SIGTERM_SIGNAL)),
        };
        for (code, signal, saw_error, saw_alertable_error, saw_node_too_old) in [
            (Some(1), None, false, false, false),
            (Some(RUNNER_OPERATION_LOCKED_EXIT), None, true, true, false),
            (Some(RUNNER_TRANSIENT_RETRY_EXIT), None, false, false, false),
            (Some(WINDOWS_CONTROL_C_EXIT), None, false, false, false),
            (Some(2), None, true, false, false),
        ] {
            assert_eq!(
                classify_runner_exit_disposition_with_cancellation(
                    code,
                    signal,
                    None,
                    false,
                    saw_error,
                    saw_alertable_error,
                    saw_node_too_old,
                ),
                classify_runner_exit_disposition(
                    code,
                    signal,
                    saw_error,
                    saw_alertable_error,
                    saw_node_too_old,
                ),
                "no cancellation evidence must delegate unchanged"
            );
        }

        for cause in [SyncCancelCause::UserStop, SyncCancelCause::AppQuit] {
            assert_eq!(
                classify_runner_exit_disposition_with_cancellation(
                    owned_code,
                    owned_signal,
                    Some(cause),
                    true,
                    false,
                    false,
                    false,
                ),
                RunnerExitDisposition::CancelledByApp(cause),
            );
        }

        // Unix terminal status shapes are attributable only with an exact,
        // observed application termination. A bare SIGKILL remains loud.
        if current_termination_host() == TerminationHost::Posix {
            assert_eq!(
                classify_runner_exit_disposition_with_cancellation(
                    None,
                    Some(SIGKILL_SIGNAL),
                    Some(SyncCancelCause::UserStop),
                    true,
                    false,
                    false,
                    false,
                ),
                RunnerExitDisposition::CancelledByApp(SyncCancelCause::UserStop),
            );
        }
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                None,
                Some(SIGKILL_SIGNAL),
                None,
                false,
                false,
                false,
                false,
            ),
            RunnerExitDisposition::Alert,
        );

        // Cancellation takes precedence over the no-capture Node marker, but
        // never over a genuine alertable runner fault.
        assert_eq!(
            classify_runner_exit_disposition_with_cancellation(
                owned_code,
                owned_signal,
                Some(SyncCancelCause::TimeoutWatchdog),
                true,
                false,
                false,
                true,
            ),
            RunnerExitDisposition::CancelledByApp(SyncCancelCause::TimeoutWatchdog),
        );

        // An exact effective cancellation still delegates every legacy special
        // disposition when its terminal status is not one produced by our
        // terminator. This keeps runner-side lock timeouts, Ctrl+C teardown,
        // and transient retry semantics byte-for-byte unchanged.
        for (code, signal) in [
            (Some(RUNNER_OPERATION_LOCKED_EXIT), None),
            (Some(WINDOWS_CONTROL_C_EXIT), None),
            (Some(RUNNER_TRANSIENT_RETRY_EXIT), None),
        ] {
            assert_eq!(
                classify_runner_exit_disposition_with_cancellation(
                    code,
                    signal,
                    Some(SyncCancelCause::TimeoutWatchdog),
                    true,
                    false,
                    false,
                    false,
                ),
                classify_runner_exit_disposition(code, signal, false, false, false),
                "a non-owned status must retain its legacy disposition"
            );
        }
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
    fn session_end_affirmation_ttl_has_a_strict_twenty_second_boundary() {
        assert_eq!(SESSION_END_AFFIRMATION_TTL_MS, 20_000);
        assert!(session_end_affirms(Some(0), 19_999));
        assert!(!session_end_affirms(Some(0), 20_000));
        assert!(!session_end_affirms(Some(0), 20_001));
        assert!(!session_end_affirms(None, 0));
    }

    /// Every attribution the app can produce. Kept as one list so the
    /// exhaustive table below cannot silently stop covering a new variant. The
    /// three terminal resolution states (`SessionEndProbed`, `SessionEndLatched`,
    /// `UnattributedNoTeardown`) are produced only after a deferral's grace,
    /// never read from the observer at exit time.
    const ALL_TERMINATOR_ATTRIBUTIONS: [WindowsTerminatorAttribution; 9] = [
        WindowsTerminatorAttribution::SessionEndObserved,
        WindowsTerminatorAttribution::SessionEndProbed,
        WindowsTerminatorAttribution::SessionEndLatched,
        WindowsTerminatorAttribution::UnattributedNoSignal,
        WindowsTerminatorAttribution::UnattributedQueryOnly,
        WindowsTerminatorAttribution::UnattributedStaleAffirmation,
        WindowsTerminatorAttribution::UnattributedNoTeardown,
        WindowsTerminatorAttribution::ObserverUnavailable,
        WindowsTerminatorAttribution::ObserverFailed,
    ];

    /// The three terminal resolution states, produced by
    /// [`resolved_session_end_attribution`] and never read raw from the observer.
    /// They must never re-trigger a deferral if fed back in as a reading.
    const TERMINAL_RESOLUTION_STATES: [WindowsTerminatorAttribution; 3] = [
        WindowsTerminatorAttribution::SessionEndProbed,
        WindowsTerminatorAttribution::SessionEndLatched,
        WindowsTerminatorAttribution::UnattributedNoTeardown,
    ];

    /// Every latch reading the producer can emit, driven from the producer's own
    /// vocabulary so a new state cannot silently escape the table below.
    const ALL_LATCH_READINGS: [SessionEndLatchReading; 3] = [
        SessionEndLatchReading::Latched,
        SessionEndLatchReading::Absent,
        SessionEndLatchReading::Unavailable,
    ];

    #[test]
    fn session_end_attribution_suppresses_only_the_affirmed_session_terminate_shape() {
        let mut attributions = vec![None];
        attributions.extend(ALL_TERMINATOR_ATTRIBUTIONS.map(Some));
        let codes = [
            Some(WINDOWS_SESSION_TERMINATE_EXIT),
            Some(0xC000_0409u32 as i32),
            Some(-1),
            Some(0),
            Some(1),
            Some(2),
            Some(126),
            Some(127),
            Some(221),
        ];

        for attribution in attributions {
            for code in codes {
                for signal in [None, Some(9)] {
                    for latch in ALL_LATCH_READINGS {
                        let actual = watcher_exit_capture_policy_with_attribution(
                            code,
                            signal,
                            attribution,
                            latch,
                        );
                        let is_session_terminate_shape =
                            code == Some(WINDOWS_SESSION_TERMINATE_EXIT) && signal.is_none();
                        let expected = if !is_session_terminate_shape {
                            // Off the session-terminate/no-signal shape neither the
                            // latch nor the attribution is consulted: real fault
                            // statuses and every signalled exit stay alertable.
                            watcher_exit_capture_policy(code, signal)
                        } else if latch.suppresses()
                            || attribution
                                == Some(WindowsTerminatorAttribution::SessionEndObserved)
                        {
                            // Positive evidence at exit: a contemporaneous latch or
                            // an observed session-end message suppresses at once.
                            WatcherExitCapturePolicy::LocalLogOnly
                        } else if attribution
                            .is_some_and(|reading| reading.is_deferrable_observer_reading())
                        {
                            // r3: every raw observer reading now defers — the two
                            // observer-fault readings as well as the unattributed
                            // family — so the probe and the latch get a second look.
                            WatcherExitCapturePolicy::DeferSessionEndDecision
                        } else {
                            // A terminal resolution state or a `None` reading
                            // delegates verbatim and never re-defers.
                            watcher_exit_capture_policy(code, signal)
                        };
                        assert_eq!(
                            actual, expected,
                            "code={code:?} signal={signal:?} attribution={attribution:?} latch={latch:?}"
                        );
                    }
                }
            }
        }
    }

    // The regression this fix exists for: a session-terminate exit the observer
    // could not attribute must no longer be captured on the spot. r3 widens this
    // to the observer-fault readings too — the exact family
    // (`ObserverFailed`/`observer_failed`) the recurrence event
    // 5bcd8d2aa8c047768419f18613426a59 (hq-sync-win@0.10.150) fired on.
    #[test]
    fn an_unattributed_session_terminate_defers_instead_of_capturing() {
        // With no contemporaneous latch, EVERY raw observer reading on the
        // session-terminate shape now defers so the r2 probe and the latch are
        // consulted after the grace, instead of firing immediately.
        for attribution in [
            WindowsTerminatorAttribution::UnattributedNoSignal,
            WindowsTerminatorAttribution::UnattributedQueryOnly,
            WindowsTerminatorAttribution::UnattributedStaleAffirmation,
            // r3: these two were sent immediately by r1 and are the recurrence.
            WindowsTerminatorAttribution::ObserverUnavailable,
            WindowsTerminatorAttribution::ObserverFailed,
        ] {
            assert!(attribution.is_deferrable_observer_reading(), "{attribution:?}");
            assert_eq!(
                watcher_exit_capture_policy_with_attribution(
                    Some(WINDOWS_SESSION_TERMINATE_EXIT),
                    None,
                    Some(attribution),
                    SessionEndLatchReading::Absent,
                ),
                WatcherExitCapturePolicy::DeferSessionEndDecision,
                "{attribution:?} must defer, not capture"
            );

            // A contemporaneous latch is positive evidence at exit: the same
            // reading suppresses immediately, exactly like an observed message.
            assert_eq!(
                watcher_exit_capture_policy_with_attribution(
                    Some(WINDOWS_SESSION_TERMINATE_EXIT),
                    None,
                    Some(attribution),
                    SessionEndLatchReading::Latched,
                ),
                WatcherExitCapturePolicy::LocalLogOnly,
                "{attribution:?} with a contemporaneous latch must suppress at once"
            );
        }
    }

    // The other half of the widened gate: the terminal resolution states and a
    // `None` reading must NEVER re-trigger a deferral — they are what a re-read
    // resolves to, so on the session-terminate shape they delegate to the
    // established (immediate) capture policy verbatim.
    #[test]
    fn terminal_resolution_states_and_none_never_redefer_on_the_session_terminate_shape() {
        for latch in [SessionEndLatchReading::Absent, SessionEndLatchReading::Unavailable] {
            for attribution in TERMINAL_RESOLUTION_STATES {
                assert!(!attribution.is_deferrable_observer_reading(), "{attribution:?}");
                assert_eq!(
                    watcher_exit_capture_policy_with_attribution(
                        Some(WINDOWS_SESSION_TERMINATE_EXIT),
                        None,
                        Some(attribution),
                        latch,
                    ),
                    WatcherExitCapturePolicy::Capture,
                    "{attribution:?} must not re-defer"
                );
            }
            assert_eq!(
                watcher_exit_capture_policy_with_attribution(
                    Some(WINDOWS_SESSION_TERMINATE_EXIT),
                    None,
                    None,
                    latch,
                ),
                WatcherExitCapturePolicy::Capture,
                "a None reading must delegate verbatim"
            );
        }
    }

    const ALL_TEARDOWN_VERDICTS: [WindowsTeardownVerdict; 3] = [
        WindowsTeardownVerdict::Confirmed,
        WindowsTeardownVerdict::Absent,
        WindowsTeardownVerdict::Unknown,
    ];

    #[test]
    fn a_deferral_drops_only_on_positive_os_evidence() {
        // Exhaustive over {every attribution} x {every verdict} x {every latch
        // reading}. A held alert drops if and only if at least one of the three
        // positive sources fired: an observed message, a contemporaneous latch,
        // or a probe-confirmed teardown. Everything else fails closed to a send.
        for attribution in ALL_TERMINATOR_ATTRIBUTIONS {
            for verdict in ALL_TEARDOWN_VERDICTS {
                for latch in ALL_LATCH_READINGS {
                    let observed =
                        attribution == WindowsTerminatorAttribution::SessionEndObserved;
                    let confirmed = verdict == WindowsTeardownVerdict::Confirmed;
                    let expected = if observed || latch.suppresses() || confirmed {
                        DeferredSessionEndOutcome::Drop
                    } else {
                        DeferredSessionEndOutcome::Capture
                    };
                    assert_eq!(
                        deferred_session_end_outcome(attribution, verdict, latch),
                        expected,
                        "{attribution:?} + {verdict:?} + {latch:?}"
                    );

                    // Lockstep: the resolved tag suppresses exactly when the
                    // outcome drops, and sends exactly when it captures. Only the
                    // RAW readings are ever fed back at resolution in production
                    // (an observed message or a deferrable observer reading); a
                    // terminal resolution state is what a re-read *produces*, never
                    // an input, so the invariant is asserted over exactly those.
                    let is_raw_reading = attribution
                        == WindowsTerminatorAttribution::SessionEndObserved
                        || attribution.is_deferrable_observer_reading();
                    if is_raw_reading {
                        let resolved =
                            resolved_session_end_attribution(attribution, verdict, latch);
                        let tag_suppresses = matches!(
                            resolved,
                            WindowsTerminatorAttribution::SessionEndObserved
                                | WindowsTerminatorAttribution::SessionEndLatched
                                | WindowsTerminatorAttribution::SessionEndProbed
                        );
                        assert_eq!(
                            tag_suppresses,
                            expected == DeferredSessionEndOutcome::Drop,
                            "tag {resolved:?} disagrees with outcome for \
                             {attribution:?} + {verdict:?} + {latch:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn a_contemporaneous_latch_drops_every_deferrable_reading_and_names_itself() {
        // The r3 latch: for the unattributed family AND the observer-fault
        // readings, a contemporaneous latch suppresses regardless of the probe
        // verdict, and the resolved tag names `session_end_latched`.
        for attribution in [
            WindowsTerminatorAttribution::UnattributedNoSignal,
            WindowsTerminatorAttribution::UnattributedQueryOnly,
            WindowsTerminatorAttribution::UnattributedStaleAffirmation,
            WindowsTerminatorAttribution::ObserverUnavailable,
            WindowsTerminatorAttribution::ObserverFailed,
        ] {
            for verdict in ALL_TEARDOWN_VERDICTS {
                assert_eq!(
                    deferred_session_end_outcome(
                        attribution,
                        verdict,
                        SessionEndLatchReading::Latched
                    ),
                    DeferredSessionEndOutcome::Drop,
                    "{attribution:?} + {verdict:?} + latch must drop"
                );
                assert_eq!(
                    resolved_session_end_attribution(
                        attribution,
                        verdict,
                        SessionEndLatchReading::Latched
                    ),
                    WindowsTerminatorAttribution::SessionEndLatched,
                    "{attribution:?} + {verdict:?} + latch must name the latch"
                );
            }
        }
        // An absent or unavailable latch is not evidence: with an Unknown probe
        // and no message, the observer-fault readings still SEND.
        for latch in [SessionEndLatchReading::Absent, SessionEndLatchReading::Unavailable] {
            assert_eq!(
                deferred_session_end_outcome(
                    WindowsTerminatorAttribution::ObserverFailed,
                    WindowsTeardownVerdict::Unknown,
                    latch
                ),
                DeferredSessionEndOutcome::Capture,
                "observer_failed + Unknown + {latch:?} must still send"
            );
        }
    }

    #[test]
    fn the_latch_honours_the_affirmation_ttl_boundary() {
        // The latch shares the observer affirmation's 20s TTL, evaluated by the
        // pure mapper. One millisecond inside the window latches; the boundary
        // itself and everything past it fail closed to `Absent` and thus SEND.
        let latched_at = 1_000u64;
        let just_inside = latched_at + SESSION_END_AFFIRMATION_TTL_MS - 1;
        let at_boundary = latched_at + SESSION_END_AFFIRMATION_TTL_MS;
        assert_eq!(
            session_end_latch_reading(Some(latched_at), just_inside),
            SessionEndLatchReading::Latched
        );
        assert_eq!(
            session_end_latch_reading(Some(latched_at), at_boundary),
            SessionEndLatchReading::Absent,
            "the TTL boundary must fail closed"
        );
        assert_eq!(
            session_end_latch_reading(None, at_boundary),
            SessionEndLatchReading::Absent,
            "an unset latch is Absent, never Latched"
        );
        // The boundary reading, fed to the exit-time policy, must therefore
        // DEFER (fail closed) rather than suppress.
        assert_eq!(
            watcher_exit_capture_policy_with_attribution(
                Some(WINDOWS_SESSION_TERMINATE_EXIT),
                None,
                Some(WindowsTerminatorAttribution::ObserverFailed),
                session_end_latch_reading(Some(latched_at), at_boundary),
            ),
            WatcherExitCapturePolicy::DeferSessionEndDecision
        );
    }

    #[test]
    fn only_a_confirmed_teardown_suppresses_a_deferrable_reading() {
        // The exact recurrence shape the post-fix events reported: registered or
        // FAILED observer, no message, DBG_TERMINATE_PROCESS, no latch. Confirmed
        // suppresses; Absent and Unknown both fail closed to a send. r3 extends
        // this from the unattributed family to the observer-fault readings too
        // (recurrence event 5bcd8d2aa8c047768419f18613426a59 was ObserverFailed):
        // if the OS probe confirms the teardown, a failed observer is a false
        // alarm, not a crash.
        for attribution in [
            WindowsTerminatorAttribution::UnattributedNoSignal,
            WindowsTerminatorAttribution::UnattributedQueryOnly,
            WindowsTerminatorAttribution::UnattributedStaleAffirmation,
            WindowsTerminatorAttribution::ObserverFailed,
            WindowsTerminatorAttribution::ObserverUnavailable,
        ] {
            assert!(attribution.is_deferrable_observer_reading(), "{attribution:?}");
            assert_eq!(
                deferred_session_end_outcome(
                    attribution,
                    WindowsTeardownVerdict::Confirmed,
                    SessionEndLatchReading::Absent
                ),
                DeferredSessionEndOutcome::Drop,
                "{attribution:?} + a confirmed teardown must suppress"
            );
            for verdict in [WindowsTeardownVerdict::Absent, WindowsTeardownVerdict::Unknown] {
                assert_eq!(
                    deferred_session_end_outcome(
                        attribution,
                        verdict,
                        SessionEndLatchReading::Absent
                    ),
                    DeferredSessionEndOutcome::Capture,
                    "{attribution:?} + {verdict:?} + no latch must still send (fail closed)"
                );
            }
        }
    }

    #[test]
    fn the_teardown_verdict_confirms_only_on_positive_evidence() {
        use TeardownLogReading as Log;
        use TeardownShuttingDown as Sd;

        let verdict = |exit, resolve, log| {
            windows_teardown_verdict(WindowsTeardownProbeReading {
                shuttingdown_at_exit: exit,
                shuttingdown_at_resolve: resolve,
                log,
            })
        };

        // A live shutting-down flag confirms from either read.
        assert_eq!(
            verdict(Sd::Yes, Sd::No, Log::None),
            WindowsTeardownVerdict::Confirmed
        );
        assert_eq!(
            verdict(Sd::No, Sd::Yes, Log::None),
            WindowsTeardownVerdict::Confirmed
        );
        // A COMMITTED System-channel record (the OS actually shut down) confirms
        // even with both flags negative.
        for committed in [TeardownLogClass::KernelGeneral, TeardownLogClass::KernelPower] {
            assert!(committed.is_committed_teardown());
            assert_eq!(
                verdict(Sd::No, Sd::No, Log::Record(committed)),
                WindowsTeardownVerdict::Confirmed,
                "{committed:?} proves the teardown proceeded"
            );
        }
        // A positive flag wins even when the log is unreadable.
        assert_eq!(
            verdict(Sd::Yes, Sd::Unavailable, Log::Unavailable),
            WindowsTeardownVerdict::Confirmed
        );

        // An INITIATION-only record (User32 1074) does NOT confirm on its own: a
        // shutdown can be initiated and then aborted. With both flags negative it
        // is neither Confirmed nor Absent — it fails closed to Unknown, and the
        // record is preserved for diagnostics rather than suppressing an alert.
        assert!(!TeardownLogClass::User32Initiated.is_committed_teardown());
        assert_eq!(
            verdict(Sd::No, Sd::No, Log::Record(TeardownLogClass::User32Initiated)),
            WindowsTeardownVerdict::Unknown,
            "a bare initiation must never suppress a coincident real crash"
        );
        // But a live flag still confirms even when only an initiation was logged.
        assert_eq!(
            verdict(
                Sd::Yes,
                Sd::No,
                Log::Record(TeardownLogClass::User32Initiated)
            ),
            WindowsTeardownVerdict::Confirmed
        );

        // Absent requires unanimous negatives across every source, with the
        // channel open and holding NO record at all — not even an initiation.
        assert_eq!(
            verdict(Sd::No, Sd::No, Log::None),
            WindowsTeardownVerdict::Absent
        );

        // Any non-unanimous, non-positive mix fails closed to Unknown.
        assert_eq!(
            verdict(Sd::No, Sd::No, Log::Unavailable),
            WindowsTeardownVerdict::Unknown
        );
        assert_eq!(
            verdict(Sd::Unavailable, Sd::Unavailable, Log::Unavailable),
            WindowsTeardownVerdict::Unknown
        );
        assert_eq!(
            verdict(Sd::No, Sd::Unavailable, Log::None),
            WindowsTeardownVerdict::Unknown
        );
    }

    #[test]
    fn the_resolved_attribution_tracks_the_verdict_and_agrees_with_the_outcome() {
        // Observed always keeps its own value and drops, regardless of latch.
        for verdict in ALL_TEARDOWN_VERDICTS {
            for latch in ALL_LATCH_READINGS {
                assert_eq!(
                    resolved_session_end_attribution(
                        WindowsTerminatorAttribution::SessionEndObserved,
                        verdict,
                        latch
                    ),
                    WindowsTerminatorAttribution::SessionEndObserved
                );
            }
        }
        // An unattributed reading with no latch is renamed by the verdict, and
        // the rename agrees with the drop/capture decision for the same inputs.
        for attribution in [
            WindowsTerminatorAttribution::UnattributedNoSignal,
            WindowsTerminatorAttribution::UnattributedQueryOnly,
            WindowsTerminatorAttribution::UnattributedStaleAffirmation,
        ] {
            let no_latch = SessionEndLatchReading::Absent;
            assert_eq!(
                resolved_session_end_attribution(
                    attribution,
                    WindowsTeardownVerdict::Confirmed,
                    no_latch
                ),
                WindowsTerminatorAttribution::SessionEndProbed
            );
            assert_eq!(
                resolved_session_end_attribution(
                    attribution,
                    WindowsTeardownVerdict::Absent,
                    no_latch
                ),
                WindowsTerminatorAttribution::UnattributedNoTeardown
            );
            // Unknown keeps the original discriminated value.
            assert_eq!(
                resolved_session_end_attribution(
                    attribution,
                    WindowsTeardownVerdict::Unknown,
                    no_latch
                ),
                attribution
            );
            // A suppressing rename must coincide with a Drop outcome, and a
            // sending rename with a Capture outcome — the tag never lies.
            assert_eq!(
                deferred_session_end_outcome(
                    attribution,
                    WindowsTeardownVerdict::Confirmed,
                    no_latch
                ),
                DeferredSessionEndOutcome::Drop
            );
            assert_eq!(
                deferred_session_end_outcome(
                    attribution,
                    WindowsTeardownVerdict::Absent,
                    no_latch
                ),
                DeferredSessionEndOutcome::Capture
            );
        }
        // An observer-fault reading with no latch keeps its own raw value when it
        // sends (Absent/Unknown), and is renamed to the suppressing SessionEndProbed
        // only when the probe confirmed — never to an unattributed_* token it is not.
        for attribution in [
            WindowsTerminatorAttribution::ObserverFailed,
            WindowsTerminatorAttribution::ObserverUnavailable,
        ] {
            let no_latch = SessionEndLatchReading::Absent;
            assert_eq!(
                resolved_session_end_attribution(
                    attribution,
                    WindowsTeardownVerdict::Confirmed,
                    no_latch
                ),
                WindowsTerminatorAttribution::SessionEndProbed
            );
            for verdict in [WindowsTeardownVerdict::Absent, WindowsTeardownVerdict::Unknown] {
                assert_eq!(
                    resolved_session_end_attribution(attribution, verdict, no_latch),
                    attribution,
                    "{attribution:?} + {verdict:?} + no latch keeps its raw value"
                );
            }
        }
    }

    #[test]
    fn a_deferred_capture_keeps_the_crash_loop_milestone_limiter() {
        let deferred = WatcherExitCapturePolicy::DeferSessionEndDecision;
        for consecutive in [1, 2, 4, 8, 16] {
            assert!(
                should_capture_watcher_exit(deferred, consecutive),
                "milestone #{consecutive} must still send"
            );
        }
        for consecutive in [3, 5, 6, 7, 9] {
            assert!(
                !should_capture_watcher_exit(deferred, consecutive),
                "non-milestone #{consecutive} must stay limited"
            );
        }
        // Byte for byte the `Capture` limiter — a deferral delays a send, it
        // never changes which sends happen.
        for consecutive in 1..64u32 {
            assert_eq!(
                should_capture_watcher_exit(deferred, consecutive),
                should_capture_watcher_exit(WatcherExitCapturePolicy::Capture, consecutive),
                "deferral diverged from Capture at #{consecutive}"
            );
        }
    }

    #[test]
    fn the_session_end_grace_sits_inside_both_of_its_ceilings() {
        assert_eq!(SESSION_END_GRACE_MS, 6_000);
        // Never outlive the affirmation window it waits on.
        assert!(SESSION_END_GRACE_MS < SESSION_END_AFFIRMATION_TTL_MS);
        // Windows' 5s default WaitToKillAppTimeout plus the app's own ~1.75s
        // capped session-end teardown: at a real session end the app reaches
        // its exit path and drops the deferral rather than racing it.
        assert!(SESSION_END_GRACE_MS < 5_000 + 1_750);
    }

    #[test]
    fn an_affirmation_inside_the_grace_suppresses_and_one_outside_it_does_not() {
        // The forward half of the window, expressed against the same TTL the
        // backward half uses: an affirmation stamped anywhere within the grace
        // is still fresh when the deferral re-reads it.
        let exit_at_ms = 100_000;
        let affirmed_just_inside = exit_at_ms + SESSION_END_GRACE_MS - 1;
        let resolves_at = exit_at_ms + SESSION_END_GRACE_MS;
        assert!(session_end_affirms(Some(affirmed_just_inside), resolves_at));

        // And an affirmation that never arrives leaves the held-back event to
        // send — the grace delays an alert, it never cancels one.
        assert!(!session_end_affirms(None, resolves_at));

        // The 20s TTL still fails closed at exactly 20000ms, unchanged.
        assert!(session_end_affirms(Some(0), 19_999));
        assert!(!session_end_affirms(Some(0), 20_000));
    }

    #[test]
    fn the_query_phase_shares_the_committed_ends_freshness_boundary() {
        // One boundary, two callers: a query recorded 20s ago is no more
        // contemporaneous than a commit recorded 20s ago, so a stale query can
        // never masquerade as a live session-end phase hours later.
        assert!(session_end_signal_is_fresh(Some(0), 19_999));
        assert!(!session_end_signal_is_fresh(Some(0), 20_000));
        assert!(!session_end_signal_is_fresh(None, 0));
        for now in [0, 1, 19_999, 20_000, 50_000] {
            assert_eq!(
                session_end_signal_is_fresh(Some(0), now),
                session_end_affirms(Some(0), now),
                "the two freshness checks diverged at {now}"
            );
        }
    }

    #[test]
    fn terminator_attribution_names_stay_a_fixed_content_safe_vocabulary() {
        let names: Vec<&str> = ALL_TERMINATOR_ATTRIBUTIONS
            .iter()
            .map(|attribution| attribution.class_name())
            .collect();
        assert_eq!(
            names,
            vec![
                "session_end_observed",
                "session_end_probed",
                "session_end_latched",
                "unattributed_no_signal",
                "unattributed_query_only",
                "unattributed_stale_affirmation",
                "unattributed_no_teardown",
                "observer_unavailable",
                "observer_failed",
            ]
        );
        // The undiscriminated value is gone: a residual recurrence has to name
        // which link of the chain failed.
        assert!(!names.contains(&"unattributed"));
        for name in &names {
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "{name} is not a fixed-vocabulary tag token"
            );
        }

        // The probe's own wire vocabulary is equally fixed and content-safe.
        let probe_tokens = [
            WindowsTeardownVerdict::Confirmed.class_name(),
            WindowsTeardownVerdict::Absent.class_name(),
            WindowsTeardownVerdict::Unknown.class_name(),
            TeardownShuttingDown::Yes.class_name(),
            TeardownShuttingDown::No.class_name(),
            TeardownShuttingDown::Unavailable.class_name(),
            TeardownLogReading::Record(TeardownLogClass::User32Initiated).class_name(),
            TeardownLogReading::Record(TeardownLogClass::KernelGeneral).class_name(),
            TeardownLogReading::Record(TeardownLogClass::KernelPower).class_name(),
            TeardownLogReading::None.class_name(),
            TeardownLogReading::Unavailable.class_name(),
        ];
        for token in probe_tokens {
            assert!(
                token
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "{token} is not a fixed-vocabulary probe token"
            );
        }

        for (waited, bucket) in [
            (0u64, "under_1s"),
            (999, "under_1s"),
            (1_000, "1s_to_3s"),
            (2_999, "1s_to_3s"),
            (3_000, "3s_to_6s"),
            (5_999, "3s_to_6s"),
            (6_000, "at_or_over_6s"),
            (60_000, "at_or_over_6s"),
        ] {
            assert_eq!(
                session_end_grace_waited_bucket(waited),
                bucket,
                "{waited}ms"
            );
        }
    }

    /// A realistic User32 Event 1074 (shutdown initiated) as `EvtRender` emits
    /// it, carrying an initiating user, a full process path and a machine name —
    /// exactly the fields a careless parser could leak.
    const SAMPLE_USER32_1074: &str = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='User32' Guid='{b0aa8734-56f1-4918-a988-b7d54bb8a4b5}' EventSourceName='User32'/><EventID Qualifiers='32768'>1074</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8080000000000000</Keywords><TimeCreated SystemTime='2026-08-20T05:11:57.1234567Z'/><EventRecordID>90210</EventRecordID><Correlation/><Execution ProcessID='1064' ThreadID='2088'/><Channel>System</Channel><Computer>DESKTOP-QOH7J4N</Computer><Security UserID='S-1-5-21-1111-2222-3333-1001'/></System><EventData><Data Name='param1'>C:\Windows\System32\shutdown.exe (DESKTOP-QOH7J4N)</Data><Data Name='param2'>DESKTOP-QOH7J4N</Data><Data Name='param5'>power off</Data><Data Name='param7'>Ada</Data></EventData></Event>"#;

    #[test]
    fn parse_teardown_record_recognises_only_the_three_initiation_records() {
        assert_eq!(
            parse_teardown_record(SAMPLE_USER32_1074).map(|record| record.class),
            Some(TeardownLogClass::User32Initiated)
        );

        let kernel_general = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-General' Guid='{a68ca8b7}'/><EventID>13</EventID><TimeCreated SystemTime='2026-08-20T05:11:58.5Z'/><Channel>System</Channel><Computer>DESKTOP-QOH7J4N</Computer></System><EventData><Data Name='StopTime'>2026-08-20T05:11:58Z</Data></EventData></Event>"#;
        assert_eq!(
            parse_teardown_record(kernel_general).map(|record| record.class),
            Some(TeardownLogClass::KernelGeneral)
        );

        let kernel_power = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-Power' Guid='{331c3b3a}'/><EventID>109</EventID><TimeCreated SystemTime='2026-08-20T05:11:59Z'/><Channel>System</Channel></System><EventData><Data Name='TransitionsToOff'>1</Data></EventData></Event>"#;
        assert_eq!(
            parse_teardown_record(kernel_power).map(|record| record.class),
            Some(TeardownLogClass::KernelPower)
        );

        // A matching EventID under the WRONG provider is rejected — the id alone
        // is not evidence.
        let wrong_provider = r#"<Event><System><Provider Name='Some-Other-Provider'/><EventID>1074</EventID><TimeCreated SystemTime='2026-08-20T05:11:59Z'/></System></Event>"#;
        assert_eq!(parse_teardown_record(wrong_provider), None);

        // An unrelated System event is not a teardown record at all.
        let unrelated = r#"<Event><System><Provider Name='Service Control Manager'/><EventID>7036</EventID><TimeCreated SystemTime='2026-08-20T05:11:59Z'/></System></Event>"#;
        assert_eq!(parse_teardown_record(unrelated), None);
    }

    #[test]
    fn parse_teardown_record_extracts_only_content_safe_fields() {
        let record =
            parse_teardown_record(SAMPLE_USER32_1074).expect("1074 must parse to a record");
        // Only a fixed class token and a bare integer time survive parsing.
        assert_eq!(record.class, TeardownLogClass::User32Initiated);
        assert!(record.event_time_unix_ms.is_some());

        // The Debug rendering of the parsed record — the only thing that could
        // ever reach a log/tag/extra — must not carry any raw field from the XML.
        let rendered = format!("{record:?}");
        for leaked in [
            "shutdown.exe",
            "DESKTOP-QOH7J4N",
            "Ada",
            "S-1-5-21",
            "power off",
            r"C:\Windows",
            "param1",
        ] {
            assert!(
                !rendered.contains(leaked),
                "parsed teardown record leaked {leaked:?}: {rendered}"
            );
        }
        assert_eq!(record.class.class_name(), "user32_1074");
    }

    #[test]
    fn a_teardown_record_brackets_only_a_contemporaneous_exit() {
        let exit_ms = 1_760_000_000_000;
        let now_ms = exit_ms + SESSION_END_GRACE_MS as i64;

        let at_exit = TeardownRecord {
            class: TeardownLogClass::KernelGeneral,
            event_time_unix_ms: Some(exit_ms),
        };
        assert!(teardown_record_brackets_exit(&at_exit, exit_ms, now_ms));

        // A record initiated a few seconds before the child died still brackets.
        let just_before = TeardownRecord {
            event_time_unix_ms: Some(exit_ms - 3_000),
            ..at_exit
        };
        assert!(teardown_record_brackets_exit(&just_before, exit_ms, now_ms));

        // A boot-time record from a previous session — hours earlier — does not,
        // which is what stops a healthy runner's historical shutdown from ever
        // reading as a live teardown.
        let last_boot = TeardownRecord {
            event_time_unix_ms: Some(exit_ms - 6 * 60 * 60 * 1000),
            ..at_exit
        };
        assert!(!teardown_record_brackets_exit(&last_boot, exit_ms, now_ms));

        // A record with no parseable time is never treated as bracketing —
        // absence of a time is not evidence of contemporaneity.
        let no_time = TeardownRecord {
            event_time_unix_ms: None,
            ..at_exit
        };
        assert!(!teardown_record_brackets_exit(&no_time, exit_ms, now_ms));
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

    // ── V8 heap-OOM retention + attribution (HQ-DESKTOP-55) ─────────────────
    //
    // Both fixtures are the EXACT stderr of a real reproduced V8 heap OOM on
    // node v22 (exit 134/SIGABRT). They share an identical first-8 machinery
    // prefix and diverge only from frame 9, differing in their allocating
    // frame — the direct proof the review demanded that a fixed 8-frame window
    // plus fixed-token hashing cannot discriminate them, but a signature over
    // the full captured section can.

    /// Fixture A — array-allocation OOM, 16 native frames, allocating frame
    /// `v8::internal::Runtime_NewArray` at depth 15.
    const HEAP_OOM_FIXTURE_A: &[&str] = &[
        "",
        "<--- Last few GCs --->",
        "",
        "[1174487:0x1e0a3000]       66 ms: Mark-Compact 47.7 (80.5) -> 47.7 (80.5) MB, pooled: 0 MB, 1.65 / 0.00 ms  (average mu = 0.862, current mu = 0.808) allocation failure; scavenge might not succeed",
        "",
        "",
        "<--- JS stacktrace --->",
        "",
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
        "----- Native stack trace -----",
        "",
        " 1: 0xe46bbe node::OOMErrorHandler(char const*, v8::OOMDetails const&) [node]",
        " 2: 0x1243740 v8::Utils::ReportOOMFailure(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]",
        " 3: 0x1243a17 v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]",
        " 4: 0x1472925  [node]",
        " 5: 0x148c1b9 v8::internal::Heap::CollectGarbage(v8::internal::AllocationSpace, v8::internal::GarbageCollectionReason, v8::GCCallbackFlags) [node]",
        " 6: 0x14608b8 v8::internal::HeapAllocator::AllocateRawWithLightRetrySlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]",
        " 7: 0x14617e5 v8::internal::HeapAllocator::AllocateRawWithRetryOrFailSlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]",
        " 8: 0x1439b0e v8::internal::Factory::AllocateRaw(int, v8::internal::AllocationType, v8::internal::AllocationAlignment) [node]",
        " 9: 0x1427e9a v8::internal::FactoryBase<v8::internal::Factory>::AllocateRawArray(int, v8::internal::AllocationType, v8::internal::AllocationAlignment) [node]",
        "10: 0x1428608 v8::internal::FactoryBase<v8::internal::Factory>::NewFixedDoubleArray(int, v8::internal::AllocationType) [node]",
        "11: 0x16075a6  [node]",
        "12: 0x1621b62  [node]",
        "13: 0x1642638  [node]",
        "14: 0x1644ba5 v8::internal::ArrayConstructInitializeElements(v8::internal::Handle<v8::internal::JSArray>, v8::internal::Arguments<(v8::internal::ArgumentsType)1>*) [node]",
        "15: 0x1889f5d v8::internal::Runtime_NewArray(int, unsigned long*, v8::internal::Isolate*) [node]",
        "16: 0x1dfcaf6  [node]",
        "timeout: the monitored command dumped core",
    ];

    /// Fixture B — string-flatten OOM, 14 native frames, allocating frame
    /// `v8::internal::Runtime_StringSubstring` at depth 13. GC line is `47.4`.
    const HEAP_OOM_FIXTURE_B: &[&str] = &[
        "",
        "<--- Last few GCs --->",
        "",
        "[2510830:0x1f857000]       73 ms: Mark-Compact 47.4 (80.5) -> 47.4 (80.5) MB, pooled: 0 MB, 8.34 / 0.00 ms  (average mu = 0.681, current mu = 0.276) allocation failure; scavenge might not succeed",
        "",
        "",
        "<--- JS stacktrace --->",
        "",
        "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
        "----- Native stack trace -----",
        "",
        " 1: 0xe46bbe node::OOMErrorHandler(char const*, v8::OOMDetails const&) [node]",
        " 2: 0x1243740 v8::Utils::ReportOOMFailure(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]",
        " 3: 0x1243a17 v8::internal::V8::FatalProcessOutOfMemory(v8::internal::Isolate*, char const*, v8::OOMDetails const&) [node]",
        " 4: 0x1472925  [node]",
        " 5: 0x148c1b9 v8::internal::Heap::CollectGarbage(v8::internal::AllocationSpace, v8::internal::GarbageCollectionReason, v8::GCCallbackFlags) [node]",
        " 6: 0x14608b8 v8::internal::HeapAllocator::AllocateRawWithLightRetrySlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]",
        " 7: 0x14617e5 v8::internal::HeapAllocator::AllocateRawWithRetryOrFailSlowPath(int, v8::internal::AllocationType, v8::internal::AllocationOrigin, v8::internal::AllocationAlignment) [node]",
        " 8: 0x1439b0e v8::internal::Factory::AllocateRaw(int, v8::internal::AllocationType, v8::internal::AllocationAlignment) [node]",
        " 9: 0x1428944 v8::internal::FactoryBase<v8::internal::Factory>::AllocateRawWithImmortalMap(int, v8::internal::AllocationType, v8::internal::Tagged<v8::internal::Map>, v8::internal::AllocationAlignment) [node]",
        "10: 0x1429e0e v8::internal::FactoryBase<v8::internal::Factory>::NewRawOneByteString(int, v8::internal::AllocationType) [node]",
        "11: 0x178001d v8::internal::String::SlowFlatten(v8::internal::Isolate*, v8::internal::Handle<v8::internal::ConsString>, v8::internal::AllocationType) [node]",
        "12: 0x143d1eb v8::internal::Factory::NewProperSubString(v8::internal::Handle<v8::internal::String>, int, int) [node]",
        "13: 0x18bd5ea v8::internal::Runtime_StringSubstring(int, unsigned long*, v8::internal::Isolate*) [node]",
        "14: 0x1dfcaf6  [node]",
        "timeout: the monitored command dumped core",
    ];

    fn feed_stderr(totals: &mut RunTotals, lines: &[&str]) {
        for line in lines {
            totals.record_stderr_line(line);
        }
    }

    /// The expected first-8 shape both fixtures share (their machinery prefix).
    const HEAP_OOM_SHARED_SHAPE: &str = "node_oom_handler>v8_report_oom>v8_fatal_process_oom>anon>\
         v8_heap>v8_heap_allocator>v8_heap_allocator>v8_factory";

    #[test]
    fn heap_oom_fixture_a_yields_class_scoped_shape_and_evidence() {
        // PRE-FIX pin (mandatory non-vacuity): the generic tail path over the
        // shipped last-8 lines is exactly the observed HQ-DESKTOP-55 output —
        // all_redacted / unknown / redacted == depth — so the improvement is real.
        let last_eight: Vec<String> = HEAP_OOM_FIXTURE_A
            .iter()
            .rev()
            .take(RUNNER_STACK_FRAME_CAP)
            .rev()
            .map(|line| line.to_string())
            .collect();
        let generic = runner_stack_shape(&last_eight);
        assert_eq!(generic.shape, "all_redacted");
        assert_eq!(generic.signature, "unknown");
        assert_eq!(generic.redacted_frames, generic.depth);

        let mut totals = RunTotals::default();
        feed_stderr(&mut totals, HEAP_OOM_FIXTURE_A);

        assert_eq!(totals.runner_heap_oom_banner(), Some("reached_heap_limit"));
        assert_eq!(totals.runner_heap_used_total_mb(), Some((48, 81)));
        assert_eq!(totals.runner_heap_oom_frame_count(), Some(16));

        let stack = totals.runner_heap_oom_stack().expect("class-scoped shape");
        assert_eq!(stack.shape, HEAP_OOM_SHARED_SHAPE);
        assert_eq!(stack.depth, 8);
        assert_eq!(stack.redacted_frames, 1);
        assert_eq!(stack.signature.len(), 16);
        assert_ne!(stack.signature, "unknown");
        assert!(stack.signature.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(stack
            .shape
            .split('>')
            .all(|token| RUNNER_STACK_TOKENS.contains(&token)));

        // The selection helper prefers the class-scoped shape over the tail.
        assert_eq!(runner_stack_shape_for_exit(&totals, &last_eight), stack);
    }

    #[test]
    fn heap_oom_fixtures_discriminate_allocation_sites() {
        let mut a = RunTotals::default();
        feed_stderr(&mut a, HEAP_OOM_FIXTURE_A);
        let mut b = RunTotals::default();
        feed_stderr(&mut b, HEAP_OOM_FIXTURE_B);

        let stack_a = a.runner_heap_oom_stack().expect("a shape");
        let stack_b = b.runner_heap_oom_stack().expect("b shape");

        // Identical first-8 machinery shape …
        assert_eq!(stack_a.shape, HEAP_OOM_SHARED_SHAPE);
        assert_eq!(stack_b.shape, HEAP_OOM_SHARED_SHAPE);
        // … but DIFFERENT full-section signatures (the review's required test).
        assert_ne!(stack_a.signature, stack_b.signature);
        assert_eq!(a.runner_heap_oom_frame_count(), Some(16));
        assert_eq!(b.runner_heap_oom_frame_count(), Some(14));
        assert_eq!(b.runner_heap_used_total_mb(), Some((47, 81)));

        // Determinism: re-feeding reproduces the identical signature (addresses,
        // pids, and module suffixes provably excluded from the digest).
        let mut a2 = RunTotals::default();
        feed_stderr(&mut a2, HEAP_OOM_FIXTURE_A);
        assert_eq!(a2.runner_heap_oom_stack().unwrap().signature, stack_a.signature);
    }

    #[test]
    fn heap_oom_signature_changes_when_only_the_allocating_frame_differs() {
        let mut original = RunTotals::default();
        feed_stderr(&mut original, HEAP_OOM_FIXTURE_A);
        let original_sig = original.runner_heap_oom_stack().unwrap().signature;

        // Fixture A with ONLY the allocating frame's symbol swapped — the
        // allocating site sits inside the digested full section, so the digest
        // must change even though every other frame is byte-identical.
        let mut swapped = RunTotals::default();
        for line in HEAP_OOM_FIXTURE_A {
            swapped.record_stderr_line(&line.replace("Runtime_NewArray", "Runtime_StringSubstring"));
        }
        assert_ne!(
            swapped.runner_heap_oom_stack().unwrap().signature,
            original_sig
        );
    }

    #[test]
    fn heap_oom_evidence_banners_rounding_and_both_or_neither() {
        // Round-half-away-from-zero on the raw GC parser.
        assert_eq!(
            parse_gc_heap_candidate("x -> 47.7 (80.5) MB, tail").map(|(u, t)| (round_mb(u), round_mb(t))),
            Some((48, 81))
        );
        assert_eq!(round_mb(47.4), 47);
        assert_eq!(round_mb(47.5), 48);
        assert_eq!(round_mb(80.5), 81);

        // Malformed / out-of-bounds GC lines degrade to absent, never wrong.
        assert_eq!(parse_gc_heap_candidate("prose with no arrow"), None);
        assert_eq!(parse_gc_heap_candidate("x -> 10.0 (20.0) kB"), None);
        assert_eq!(parse_gc_heap_candidate("x -> 2000000.0 (5.0) MB"), None);

        // Ineffective-mark-compacts banner arm.
        let mut ineffective = RunTotals::default();
        ineffective.record_stderr_line(
            "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory",
        );
        assert_eq!(
            ineffective.runner_heap_oom_banner(),
            Some("ineffective_mark_compacts")
        );

        // Banner with no preceding GC line → banner + zero frames, no MB (both-
        // or-neither), and the stack falls back (None) because there are no frames.
        let mut banner_only = RunTotals::default();
        banner_only.record_stderr_line(
            "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
        );
        assert_eq!(banner_only.runner_heap_oom_banner(), Some("reached_heap_limit"));
        assert_eq!(banner_only.runner_heap_used_total_mb(), None);
        assert_eq!(banner_only.runner_heap_oom_frame_count(), Some(0));
        assert_eq!(banner_only.runner_heap_oom_stack(), None);
    }

    #[test]
    fn heap_oom_gc_candidate_keeps_last_reading_and_freezes_peak_at_banner() {
        let mut totals = RunTotals::default();
        totals.record_stderr_line("x 10.0 (20.0) -> 10.0 (20.0) MB, tail");
        totals.record_stderr_line("x 30.4 (40.6) -> 30.4 (40.6) MB, tail");
        // The GC value can fall after its peak. The existing used/total fields
        // intentionally retain this final reading; the peak accessor must not.
        totals.record_stderr_line("x 20.1 (40.6) -> 20.1 (40.6) MB, tail");
        totals.record_stderr_line(
            "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
        );
        assert_eq!(totals.runner_heap_used_total_mb(), Some((20, 41)));
        assert_eq!(totals.runner_heap_peak_used_mb(), Some(30));
        // A GC-shaped line AFTER the banner never moves the frozen value.
        totals.record_stderr_line("x 99.9 (99.9) -> 99.9 (99.9) MB, tail");
        assert_eq!(totals.runner_heap_used_total_mb(), Some((20, 41)));
        assert_eq!(totals.runner_heap_peak_used_mb(), Some(30));
    }

    #[test]
    fn heap_oom_capture_boundaries_and_cap() {
        // Full fixture: the marker + blank preamble is tolerated, all 16 frames
        // captured, and the `timeout: … dumped core` trailer ends the capture.
        let mut totals = RunTotals::default();
        feed_stderr(&mut totals, HEAP_OOM_FIXTURE_A);
        assert_eq!(totals.runner_heap_oom_frame_count(), Some(16));

        // Cap: a banner followed by more than the cap of address-only frames caps.
        let mut capped = RunTotals::default();
        capped.record_stderr_line(
            "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
        );
        for index in 1..=40 {
            capped.record_stderr_line(&format!("{index}: 0x{index:x} v8::internal::Thing [node]"));
        }
        assert_eq!(
            capped.runner_heap_oom_frame_count(),
            Some(HEAP_OOM_FRAME_CAP as u32)
        );
    }

    #[test]
    fn heap_oom_all_anon_stack_still_beats_all_redacted() {
        // An unsymbolized build prints address-only frames: every frame normalizes
        // to `anon`, but a banner, frame count, and an honest shape + signature
        // still attach — strictly better than today's all_redacted/unknown.
        let mut totals = RunTotals::default();
        totals.record_stderr_line(
            "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
        );
        for index in 1..=5 {
            totals.record_stderr_line(&format!("{index}: 0x{index:x}  [node]"));
        }
        let stack = totals.runner_heap_oom_stack().expect("shape");
        assert_eq!(stack.shape, "anon>anon>anon>anon>anon");
        assert_eq!(stack.redacted_frames, 5);
        assert_eq!(stack.depth, 5);
        assert_ne!(stack.signature, "unknown");
        assert_eq!(stack.signature.len(), 16);
    }

    #[test]
    fn heap_oom_never_emits_paths_symbols_or_secrets() {
        let mut totals = RunTotals::default();
        totals.record_stderr_line(
            "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
        );
        // Hostile frames: a /Users path in the bracket suffix, a secret-looking
        // symbol, and an over-long symbol. Only fixed tokens + a 16-hex digest
        // may escape; the raw bytes never do.
        totals.record_stderr_line(
            " 1: 0xdead v8::internal::Runtime_Secret_sk_live_ABCDEF [/Users/alice/secret-plan.md]",
        );
        totals.record_stderr_line(&format!(" 2: 0xbeef node::{} [node]", "A".repeat(4096)));
        let stack = totals.runner_heap_oom_stack().expect("shape");
        assert_eq!(stack.shape, "v8_runtime>node_native");
        for token in stack.shape.split('>') {
            assert!(RUNNER_STACK_TOKENS.contains(&token), "leaked token {token}");
        }
        assert_eq!(stack.signature.len(), 16);
        for needle in ["/Users", "sk_live", "secret-plan", "AAAA"] {
            assert!(!stack.shape.contains(needle), "shape leaked {needle}");
            assert!(!stack.signature.contains(needle), "signature leaked {needle}");
        }
    }

    #[test]
    fn heap_oom_reset_clears_all_state() {
        let mut totals = RunTotals::default();
        feed_stderr(&mut totals, HEAP_OOM_FIXTURE_A);
        assert!(totals.runner_heap_oom_stack().is_some());
        // The per-pass reset (AllComplete / fresh run) clears every heap field.
        totals = RunTotals::default();
        assert_eq!(totals.runner_heap_oom_banner(), None);
        assert_eq!(totals.runner_heap_used_total_mb(), None);
        assert_eq!(totals.runner_heap_oom_frame_count(), None);
        assert_eq!(totals.runner_heap_oom_stack(), None);
    }

    #[test]
    fn non_heap_oom_stderr_leaves_generic_path_untouched() {
        let mut totals = RunTotals::default();
        totals.record_stderr_line(
            r"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src/win/async.c, line 76",
        );
        totals.record_stderr_line(r#"{"type":"error","code":"X","message":"nope"}"#);
        assert_eq!(totals.runner_heap_oom_banner(), None);
        assert_eq!(totals.runner_heap_oom_stack(), None);
        // The selection helper returns the generic tail shape byte-identically.
        let tail = vec!["at node:fs:1:1".to_string()];
        assert_eq!(
            runner_stack_shape_for_exit(&totals, &tail),
            runner_stack_shape(&tail)
        );
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

    #[test]
    fn two_distinct_libuv_async_assertions_yield_distinct_identity_same_shape() {
        // HQ-DESKTOP-50: two DIFFERENT assertions in the same libuv source today
        // collapse to byte-identical telemetry (shape-hash signature only). The
        // assertion parser recovers the discriminating identity: same source
        // token, DIFFERENT expression signature, and each line's own integer.
        let a = parse_runner_assertion(
            r"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76",
        )
        .expect("assertion a parses");
        let b = parse_runner_assertion(
            r"Assertion failed: handle->async_sent == 0, file src\win\async.c, line 112",
        )
        .expect("assertion b parses");

        assert_eq!(a.source, "libuv_win_async");
        assert_eq!(b.source, "libuv_win_async");
        assert_eq!(a.line, Some(76));
        assert_eq!(b.line, Some(112));
        assert_ne!(
            a.signature, b.signature,
            "distinct expressions must produce distinct signatures"
        );
        // 16-hex digest shape, and never the expression text.
        for assertion in [&a, &b] {
            assert_eq!(assertion.signature.len(), 16);
            assert!(assertion
                .signature
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()));
        }
        assert!(!a.signature.contains("UV_HANDLE_CLOSING"));

        // Routed through the same RunTotals seam both telemetry routes read: the
        // two lines produce distinct stored signatures while keeping the class.
        let mut totals_a = RunTotals::default();
        totals_a.record_stderr_line(
            r"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76",
        );
        let mut totals_b = RunTotals::default();
        totals_b.record_stderr_line(
            r"Assertion failed: handle->async_sent == 0, file src\win\async.c, line 112",
        );
        assert_eq!(totals_a.runner_fatal_class, RunnerFatalClass::LibuvAssert);
        assert_eq!(totals_b.runner_fatal_class, RunnerFatalClass::LibuvAssert);
        assert_eq!(totals_a.runner_assert_source(), Some("libuv_win_async"));
        assert_ne!(
            totals_a.runner_assert_signature(),
            totals_b.runner_assert_signature()
        );
        assert_eq!(totals_a.runner_assert_line(), Some(76));
    }

    #[test]
    fn runner_assertion_never_copies_input_bytes() {
        // The canonical live line with a private Windows path appended after the
        // line number (the fixture shape used elsewhere in this file). No field
        // may carry any part of the expression, the path, or the username.
        let private = r"C:\Users\Ada\companies\personal\secret-plan.md";
        let line = format!(
            "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76: {private}"
        );
        let assertion = parse_runner_assertion(&line).expect("assertion parses");
        assert_eq!(assertion.source, "libuv_win_async");
        assert_eq!(assertion.line, Some(76));
        let rendered = format!(
            "{}|{}|{:?}",
            assertion.source, assertion.signature, assertion.line
        );
        for forbidden in [
            "Ada",
            "secret-plan",
            "personal",
            "async.c",
            "UV_HANDLE_CLOSING",
            "handle",
        ] {
            assert!(
                !rendered.contains(forbidden),
                "assertion identity leaked {forbidden}"
            );
        }
    }

    #[test]
    fn non_assertion_and_malformed_lines_carry_no_wrong_identity() {
        // A non-assertion line yields no assertion at all — no sentinel spam.
        assert_eq!(
            parse_runner_assertion("ReadDirectoryChangesW: (5) Access is denied."),
            None
        );
        assert_eq!(parse_runner_assertion(""), None);

        // A malformed `line` field degrades to absent, never a wrong integer;
        // an unrecognised source degrades to the `other` sentinel.
        let malformed = parse_runner_assertion(
            "Assertion failed: cond, file src/vendor/thing.c, line notanumber",
        )
        .expect("expression present");
        assert_eq!(malformed.source, "other");
        assert_eq!(malformed.line, None);
        assert!(!malformed.signature.is_empty());

        // Non-assertion fatal classes leave the assertion fields untouched.
        let mut totals = RunTotals::default();
        totals.record_stderr_line("ReadDirectoryChangesW: (5) Access is denied.");
        assert_eq!(totals.runner_fatal_class, RunnerFatalClass::LibuvFatalSyscall);
        assert_eq!(totals.runner_assert_source(), None);
        assert_eq!(totals.runner_assert_line(), None);
        assert_eq!(totals.runner_assert_signature(), None);
    }

    #[test]
    fn runner_phase_vocabulary_distinguishes_pre_protocol_from_unknown() {
        // The never-observed sentinel is a real, distinct member; a directionless
        // Progress still maps to `unknown`, so the two states are separable.
        assert_eq!(
            RUNNER_PHASE_VOCABULARY,
            &["scan", "push", "pull", "idle", "unknown", "pre_protocol"]
        );
        assert!(RUNNER_PHASE_VOCABULARY.contains(&RUNNER_PHASE_PRE_PROTOCOL));
        assert_ne!(RUNNER_PHASE_PRE_PROTOCOL, "unknown");

        let directionless: SyncEvent = serde_json::from_str(
            r#"{"type":"progress","company":"indigo","path":"private.md","bytes":1}"#,
        )
        .expect("progress event");
        assert_eq!(runner_phase_from_event(&directionless), Some("unknown"));
    }

    // ── disk-exhaustion terminal-exit misreport (HQ-DESKTOP-5D) ──────────────

    fn rollup_of(enospc: u32, eperm: u32, other: u32) -> RunnerErrorRollup {
        RunnerErrorRollup {
            enospc,
            eperm,
            other,
            ..Default::default()
        }
    }

    /// Reconstruct the exact HQ-DESKTOP-5D run shape from its content-safe axes:
    /// an ordinary stderr line, the hq-cloud ndjson ENOSPC protocol error
    /// (per-file path, no company), and an npm companion line whose own
    /// `npm error ` prefix wins the last-non-None fatal attribution — plus the
    /// parsed ENOSPC error record that drives the rollup.
    fn hq_desktop_5d_run_totals() -> RunTotals {
        let mut totals = RunTotals::default();
        // #1 ordinary line → (other;none)
        totals.record_stderr_line("[hq-cloud] starting pull for 3 companies");
        // #2 the hq-cloud ndjson ENOSPC error line → (enospc;disk_full after fix)
        let enospc_line = r#"{"type":"error","path":"companies/acme/big.bin","message":"ENOSPC: no space left on device, open 'companies/acme/big.bin'"}"#;
        totals.record_stderr_line(enospc_line);
        // #3 the npm companion line → (other;npm_install_relay), the messenger
        totals.record_stderr_line(
            "npm error A complete log of this run can be found in: /Users/x/.npm/_logs/2026-log.log",
        );
        // The parsed ENOSPC error record — what record_error increments.
        totals.record_error(&SyncErrorEvent {
            company: None,
            path: "companies/acme/big.bin".to_string(),
            message: "ENOSPC: no space left on device, open 'companies/acme/big.bin'".to_string(),
        });
        totals
    }

    #[test]
    fn hq_desktop_5d_disk_full_exit_is_diskfull_not_alert() {
        let totals = hq_desktop_5d_run_totals();
        // The rollup — immune to the last-wins fatal-class flap — proves disk-full,
        // even though the retained fatal class is the npm messenger.
        assert!(totals.runner_error_rollup.is_exclusively_disk_full());
        assert_eq!(totals.runner_fatal_class, RunnerFatalClass::NpmInstallRelay);
        assert!(!totals.saw_genuine_crash_fatal);
        assert!(totals.saw_alertable_error);
        assert!(runner_exit_is_disk_exhaustion(
            Some(1),
            None,
            totals.saw_genuine_crash_fatal,
            &totals.runner_error_rollup
        ));
        // Exit code 1, no signal, no cancellation → DiskFull (was Alert pre-fix).
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                Some(1),
                None,
                None,
                false,
                totals.saw_error,
                totals.saw_alertable_error,
                totals.saw_node_too_old,
                totals.saw_genuine_crash_fatal,
                &totals.runner_error_rollup,
            ),
            RunnerExitDisposition::DiskFull
        );
        assert!(!should_alert_on_nonzero_exit_with_fault(
            Some(1),
            None,
            totals.saw_error,
            totals.saw_alertable_error,
            totals.saw_node_too_old,
            totals.saw_genuine_crash_fatal,
            &totals.runner_error_rollup,
        ));
        // Base (pre-fix) direction is genuinely red: the same inputs Alert today.
        assert_eq!(
            classify_runner_exit_disposition(
                Some(1),
                None,
                totals.saw_error,
                totals.saw_alertable_error,
                totals.saw_node_too_old
            ),
            RunnerExitDisposition::Alert
        );
        assert!(should_alert_on_nonzero_exit(
            Some(1),
            None,
            totals.saw_error,
            totals.saw_alertable_error,
            totals.saw_node_too_old
        ));
    }

    #[test]
    fn disk_full_arm_precedes_npm_relay_but_yields_to_genuine_crashes() {
        // npm's own ENOSPC code → disk_full, not npm_install_relay (arm ordering).
        assert_eq!(
            classify_runner_fatal_class("npm error code ENOSPC"),
            RunnerFatalClass::DiskFull
        );
        assert_eq!(
            classify_runner_fatal_class("npm ERR! code ENOSPC"),
            RunnerFatalClass::DiskFull
        );
        // hq-cloud errno phrase → disk_full.
        assert_eq!(
            classify_runner_fatal_class("ENOSPC: no space left on device, open '/x/y'"),
            RunnerFatalClass::DiskFull
        );
        // A heap-OOM banner that merely also mentions ENOSPC stays HeapOom.
        assert_eq!(
            classify_runner_fatal_class(
                "FATAL ERROR: Reached heap limit — JavaScript heap out of memory (near ENOSPC)"
            ),
            RunnerFatalClass::HeapOom
        );
        // A Rust panic whose text mentions ENOSPC stays RustPanic.
        assert_eq!(
            classify_runner_fatal_class("thread 'main' panicked at 'ENOSPC: no space left on device'"),
            RunnerFatalClass::RustPanic
        );
        // Token + membership + non-crash classification.
        assert_eq!(RunnerFatalClass::DiskFull.as_str(), "disk_full");
        assert!(RunnerFatalClass::ALL.contains(&RunnerFatalClass::DiskFull));
        assert!(!RunnerFatalClass::DiskFull.is_genuine_crash());
    }

    #[test]
    fn npm_lifecycle_disk_failure_stays_npm_relay_and_alerts() {
        // A third-party build script that ran out of space: npm reports a lifecycle
        // failure (not its own top-level ENOSPC), so is_disk_exhaustion_failure
        // excludes it and the fatal class stays npm_install_relay — mirroring the
        // exclusion hq_cli_update already proves. Both spellings.
        for block in [
            "npm error code ELIFECYCLE\n\
             npm error errno 1\n\
             npm error some-pkg@1.0.0 build: `node-gyp rebuild`\n\
             npm error gyp ERR! ENOSPC: no space left on device\n\
             npm error Failed at the some-pkg@1.0.0 build script.\n\
             npm error A complete log of this run can be found in: /x/.npm/_logs/y.log",
            "npm ERR! code ELIFECYCLE\n\
             npm ERR! errno 1\n\
             npm ERR! gyp ERR! ENOSPC: no space left on device\n\
             npm ERR! command failed\n\
             npm ERR! A complete log of this run can be found in: /x/.npm/_logs/y.log",
        ] {
            assert_eq!(
                classify_runner_fatal_class(block),
                RunnerFatalClass::NpmInstallRelay,
                "npm lifecycle disk failure must stay npm_install_relay"
            );
        }
        // At the disposition level it keeps alerting: no exclusively-ENOSPC rollup.
        let empty = RunnerErrorRollup::default();
        assert!(!runner_exit_is_disk_exhaustion(Some(1), None, false, &empty));
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                Some(1),
                None,
                None,
                false,
                false,
                false,
                false,
                false,
                &empty,
            ),
            RunnerExitDisposition::Alert
        );
    }

    #[test]
    fn is_exclusively_disk_full_requires_enospc_and_nothing_else() {
        assert!(!RunnerErrorRollup::default().is_exclusively_disk_full());
        assert!(rollup_of(1, 0, 0).is_exclusively_disk_full());
        assert!(rollup_of(5, 0, 0).is_exclusively_disk_full());
        assert!(!rollup_of(1, 0, 1).is_exclusively_disk_full());
        assert!(!rollup_of(1, 1, 0).is_exclusively_disk_full());
        assert!(!rollup_of(0, 0, 1).is_exclusively_disk_full());
        assert!(rollup_of(1, 1, 0).has_non_disk_full_error());
        assert!(!rollup_of(1, 0, 0).has_non_disk_full_error());
    }

    #[test]
    fn mixed_rollup_with_enospc_still_alerts() {
        // Presence of ENOSPC is not enough; a co-occurring EPERM keeps it alerting.
        let mixed = rollup_of(1, 1, 0);
        assert!(!runner_exit_is_disk_exhaustion(Some(1), None, false, &mixed));
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                Some(1),
                None,
                None,
                false,
                true,
                true,
                false,
                false,
                &mixed,
            ),
            RunnerExitDisposition::Alert
        );
    }

    #[test]
    fn crash_class_membership_is_pinned() {
        // The six genuine-crash classes drive the sticky flag; everything else
        // (including the disk-full and npm-relay messengers) does not.
        for crash in [
            RunnerFatalClass::LibuvAssert,
            RunnerFatalClass::LibuvFatalSyscall,
            RunnerFatalClass::NodeCheckAbort,
            RunnerFatalClass::NodeFatal,
            RunnerFatalClass::HeapOom,
            RunnerFatalClass::RustPanic,
        ] {
            assert!(crash.is_genuine_crash(), "{crash:?} must be a genuine crash");
        }
        for non_crash in [
            RunnerFatalClass::ExecPermissionDenied,
            RunnerFatalClass::ExecNotFound,
            RunnerFatalClass::NodeTooOld,
            RunnerFatalClass::DiskFull,
            RunnerFatalClass::NpmInstallRelay,
            RunnerFatalClass::None,
        ] {
            assert!(!non_crash.is_genuine_crash(), "{non_crash:?} is not a crash");
        }
    }

    #[test]
    fn a_seen_crash_keeps_an_enospc_rollup_alerting() {
        // The sticky crash flag blocks disk-full suppression even with an
        // exclusively-ENOSPC rollup.
        let enospc = rollup_of(1, 0, 0);
        assert!(!runner_exit_is_disk_exhaustion(Some(1), None, true, &enospc));
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                Some(1),
                None,
                None,
                false,
                true,
                true,
                false,
                true,
                &enospc,
            ),
            RunnerExitDisposition::Alert
        );
    }

    #[test]
    fn a_genuine_crash_before_an_npm_companion_line_still_alerts() {
        // Finding 1: an ENOSPC protocol error, then a crash banner, then an npm
        // companion line. Last-non-None-wins buries the crash class under the npm
        // messenger, but the sticky flag preserves the crash so the exit stays
        // alertable rather than being suppressed as disk-full.
        let mut totals = RunTotals::default();
        totals.record_stderr_line("thread 'main' panicked at 'boom', crates/x/src/lib.rs:1:1");
        totals.record_stderr_line(
            "npm error A complete log of this run can be found in: /Users/x/.npm/_logs/z.log",
        );
        totals.record_error(&SyncErrorEvent {
            company: None,
            path: "companies/acme/f.bin".to_string(),
            message: "ENOSPC: no space left on device, write 'companies/acme/f.bin'".to_string(),
        });
        // The retained class is the npm messenger …
        assert_eq!(totals.runner_fatal_class, RunnerFatalClass::NpmInstallRelay);
        // … but the sticky flag remembers the crash, and the rollup is ENOSPC-only.
        assert!(totals.saw_genuine_crash_fatal);
        assert!(totals.runner_error_rollup.is_exclusively_disk_full());
        assert!(!runner_exit_is_disk_exhaustion(
            Some(1),
            None,
            totals.saw_genuine_crash_fatal,
            &totals.runner_error_rollup
        ));
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                Some(1),
                None,
                None,
                false,
                totals.saw_error,
                totals.saw_alertable_error,
                totals.saw_node_too_old,
                totals.saw_genuine_crash_fatal,
                &totals.runner_error_rollup,
            ),
            RunnerExitDisposition::Alert
        );
    }

    #[test]
    fn crash_signal_with_enospc_rollup_still_alerts() {
        let enospc = rollup_of(1, 0, 0);
        for signal in [
            SIGSEGV_SIGNAL,
            SIGBUS_SIGNAL_MACOS,
            SIGBUS_SIGNAL_LINUX,
            SIGABRT_SIGNAL,
            SIGKILL_SIGNAL,
            SIGILL_SIGNAL,
        ] {
            assert!(is_crash_signal(Some(signal)), "signal {signal} is a crash");
            assert!(!runner_exit_is_disk_exhaustion(None, Some(signal), false, &enospc));
            assert_eq!(
                classify_runner_exit_disposition_with_fault(
                    None,
                    Some(signal),
                    None,
                    false,
                    true,
                    true,
                    false,
                    false,
                    &enospc,
                ),
                RunnerExitDisposition::Alert,
                "crash signal {signal} with ENOSPC must still Alert"
            );
        }
        // SIGTERM is the app's cancellation signal, never a crash.
        assert!(!is_crash_signal(Some(SIGTERM_SIGNAL)));
    }

    #[test]
    fn npm_own_enospc_without_a_protocol_error_is_not_suppressed() {
        // Findings 2 & 3: an npm-own ENOSPC (or a per-line lifecycle phrase) that
        // emits NO parsed protocol error leaves the rollup empty. Suppression
        // requires the exclusively-ENOSPC rollup, so this startup shape keeps
        // alerting rather than routing to the HQ-folder free-space message (the
        // full volume may be the npx cache/home drive, and per-line classification
        // cannot see npm's multi-line lifecycle markers).
        let empty = RunnerErrorRollup::default();
        assert!(!runner_fault_is_disk_exhaustion_content(false, &empty));
        assert!(!runner_exit_is_disk_exhaustion(Some(1), None, false, &empty));
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                Some(1),
                None,
                None,
                false,
                false,
                false,
                false,
                false,
                &empty,
            ),
            RunnerExitDisposition::Alert
        );
    }

    #[test]
    fn windows_native_fault_code_with_enospc_rollup_still_alerts() {
        // Finding 0: on Windows a native fault is reported in `code` with
        // signal=None. It must never be suppressed as disk-full, even alongside an
        // exclusively-ENOSPC rollup.
        let enospc = rollup_of(1, 0, 0);
        for fault in [0xC000_0005u32, 0xC000_0409u32] {
            let code = Some(fault as i32);
            assert!(is_windows_fault_exit(code), "0x{fault:08X} is a windows fault");
            assert!(!runner_exit_is_disk_exhaustion(code, None, false, &enospc));
            assert_eq!(
                classify_runner_exit_disposition_with_fault(
                    code, None, None, false, true, true, false, false, &enospc,
                ),
                RunnerExitDisposition::Alert,
                "windows fault 0x{fault:08X} with ENOSPC must still Alert"
            );
        }
        // A conventional small exit code is Ordinary, not a fault → suppressible.
        assert!(!is_windows_fault_exit(Some(1)));
        assert!(runner_exit_is_disk_exhaustion(Some(1), None, false, &enospc));
    }

    #[test]
    fn app_cancellation_still_wins_over_disk_full() {
        // A genuine app-owned Stop that races a disk-full line stays CancelledByApp
        // (no alertable error), preserving the existing cancellation precedence.
        // The app-owned termination exit shape is host-specific, so pick the shape
        // this host's classifier recognises (Posix: SIGTERM/SIGKILL with no code;
        // Windows: exit code 1 with no signal).
        let enospc = rollup_of(1, 0, 0);
        let (code, signal) = match current_termination_host() {
            TerminationHost::Posix => (None, Some(SIGTERM_SIGNAL)),
            TerminationHost::Windows => (Some(1), None),
        };
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                code,
                signal,
                Some(SyncCancelCause::UserStop),
                true,
                false,
                false,
                false,
                false,
                &enospc,
            ),
            RunnerExitDisposition::CancelledByApp(SyncCancelCause::UserStop)
        );
    }

    #[test]
    fn fault_layer_only_ever_adds_diskfull_never_moves_an_existing_verdict() {
        // Full-input-lattice invariance: every input that is not a disk-full
        // verdict returns the byte-identical pre-fix disposition, and the only
        // change the fault layer can make is converting a base Alert to DiskFull.
        let rollups = [
            RunnerErrorRollup::default(),
            rollup_of(1, 0, 0), // exclusively disk full
            rollup_of(1, 1, 0), // mixed
            rollup_of(0, 0, 3), // other-only
        ];
        let codes = [
            None,
            Some(0),
            Some(1),
            Some(2),
            Some(RUNNER_OPERATION_LOCKED_EXIT),
            Some(RUNNER_TRANSIENT_RETRY_EXIT),
            Some(127),
            Some(0xC000_0005u32 as i32), // a Windows native fault
        ];
        let signals = [
            None,
            Some(SIGTERM_SIGNAL),
            Some(SIGABRT_SIGNAL),
            Some(SIGSEGV_SIGNAL),
            Some(SIGKILL_SIGNAL),
        ];
        let causes = [None, Some(SyncCancelCause::UserStop)];
        for &code in &codes {
            for &signal in &signals {
                for &cause in &causes {
                    for &effected in &[false, true] {
                        for &saw_error in &[false, true] {
                            for &saw_alertable in &[false, true] {
                                for &node_old in &[false, true] {
                                    for &saw_crash in &[false, true] {
                                        for rollup in &rollups {
                                            let base =
                                                classify_runner_exit_disposition_with_cancellation(
                                                    code,
                                                    signal,
                                                    cause,
                                                    effected,
                                                    saw_error,
                                                    saw_alertable,
                                                    node_old,
                                                );
                                            let fault =
                                                classify_runner_exit_disposition_with_fault(
                                                    code,
                                                    signal,
                                                    cause,
                                                    effected,
                                                    saw_error,
                                                    saw_alertable,
                                                    node_old,
                                                    saw_crash,
                                                    rollup,
                                                );
                                            if fault == RunnerExitDisposition::DiskFull {
                                                assert_eq!(
                                                    base,
                                                    RunnerExitDisposition::Alert,
                                                    "DiskFull may only replace a base Alert"
                                                );
                                                assert!(runner_exit_is_disk_exhaustion(
                                                    code, signal, saw_crash, rollup
                                                ));
                                            } else {
                                                assert_eq!(
                                                    fault, base,
                                                    "fault layer moved a non-disk-full verdict"
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn sync_disk_full_detail_is_fixed_and_content_safe() {
        // Names the condition, the one action, and the retry; never a path, an
        // exit code, the ENOSPC token, a digit, or a specific volume name.
        let m = SYNC_DISK_FULL_DETAIL;
        assert!(m.contains("HQ Sync"));
        assert!(m.to_lowercase().contains("space"));
        assert!(m.contains("Sync again"));
        assert!(!m.contains("ENOSPC"));
        assert!(!m.contains('/'));
        assert!(!m.chars().any(|c| c.is_ascii_digit()));
    }

    // ── transient file-lock terminal-exit misreport (HQ-DESKTOP-5R) ──────────

    /// A rollup carrying `ebusy` plus optional non-file-lock classes, to exercise
    /// the file-lock exclusivity gate without disturbing the disk-full helper.
    fn rollup_ebusy(ebusy: u32, eperm: u32, other: u32) -> RunnerErrorRollup {
        RunnerErrorRollup {
            ebusy,
            eperm,
            other,
            ..Default::default()
        }
    }

    /// Reconstruct the exact HQ-DESKTOP-5R run shape from its content-safe axes: an
    /// ordinary stderr line and the single hq-cloud ndjson EBUSY read error
    /// (company-level), with no crash class and no fatal signature — the reported
    /// runner_error_rollup=EBUSY:1 / runner_error_causes=ebusy:1 /
    /// runner_fatal_class=none event.
    fn hq_desktop_5r_run_totals() -> RunTotals {
        let mut totals = RunTotals::default();
        totals.record_stderr_line("[hq-cloud] starting pull for 1 company");
        totals.record_error(&SyncErrorEvent {
            company: None,
            path: "(company)".to_string(),
            message: "EBUSY: resource busy or locked, read".to_string(),
        });
        totals
    }

    #[test]
    fn hq_desktop_5r_file_lock_exit_is_filelocked_not_alert() {
        let totals = hq_desktop_5r_run_totals();
        // The parsed rollup is exactly one EBUSY, with no crash class.
        assert!(totals.runner_error_rollup.is_exclusively_file_locked());
        assert!(!totals.saw_genuine_crash_fatal);
        assert!(totals.saw_alertable_error);
        assert_eq!(totals.runner_fatal_class, RunnerFatalClass::None);
        assert!(runner_exit_is_file_lock(
            Some(2),
            None,
            totals.saw_genuine_crash_fatal,
            &totals.runner_error_rollup
        ));
        // Exit code 2, no signal, no cancellation → FileLocked (was Alert pre-fix).
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                Some(2),
                None,
                None,
                false,
                totals.saw_error,
                totals.saw_alertable_error,
                totals.saw_node_too_old,
                totals.saw_genuine_crash_fatal,
                &totals.runner_error_rollup,
            ),
            RunnerExitDisposition::FileLocked
        );
        assert!(!should_alert_on_nonzero_exit_with_fault(
            Some(2),
            None,
            totals.saw_error,
            totals.saw_alertable_error,
            totals.saw_node_too_old,
            totals.saw_genuine_crash_fatal,
            &totals.runner_error_rollup,
        ));
        // Base (pre-fix) direction is genuinely red: the same inputs Alert today.
        assert_eq!(
            classify_runner_exit_disposition(
                Some(2),
                None,
                totals.saw_error,
                totals.saw_alertable_error,
                totals.saw_node_too_old
            ),
            RunnerExitDisposition::Alert
        );
        assert!(should_alert_on_nonzero_exit(
            Some(2),
            None,
            totals.saw_error,
            totals.saw_alertable_error,
            totals.saw_node_too_old
        ));
    }

    #[test]
    fn is_exclusively_file_locked_requires_ebusy_and_nothing_else() {
        assert!(!RunnerErrorRollup::default().is_exclusively_file_locked());
        assert!(rollup_ebusy(1, 0, 0).is_exclusively_file_locked());
        assert!(rollup_ebusy(5, 0, 0).is_exclusively_file_locked());
        assert!(!rollup_ebusy(1, 0, 1).is_exclusively_file_locked()); // + other
        assert!(!rollup_ebusy(1, 1, 0).is_exclusively_file_locked()); // + eperm
        assert!(!rollup_ebusy(0, 0, 1).is_exclusively_file_locked()); // no ebusy
        assert!(rollup_ebusy(1, 1, 0).has_non_file_lock_error());
        assert!(!rollup_ebusy(1, 0, 0).has_non_file_lock_error());
    }

    #[test]
    fn file_lock_and_disk_full_recognizers_are_disjoint() {
        // An exclusively-EBUSY rollup is never disk-full, and an exclusively-ENOSPC
        // rollup is never file-lock — so the two rewrites can never both fire.
        let ebusy = rollup_ebusy(1, 0, 0);
        assert!(ebusy.is_exclusively_file_locked());
        assert!(!ebusy.is_exclusively_disk_full());
        let enospc = rollup_of(1, 0, 0);
        assert!(enospc.is_exclusively_disk_full());
        assert!(!enospc.is_exclusively_file_locked());
        // EBUSS + ENOSPC together is exclusive to neither.
        let both = rollup_of_ebusy_enospc();
        assert!(!both.is_exclusively_file_locked());
        assert!(!both.is_exclusively_disk_full());
        assert!(both.has_non_file_lock_error());
        assert!(both.has_non_disk_full_error());
    }

    fn rollup_of_ebusy_enospc() -> RunnerErrorRollup {
        RunnerErrorRollup {
            ebusy: 1,
            enospc: 1,
            ..Default::default()
        }
    }

    #[test]
    fn mixed_rollup_with_ebusy_still_alerts() {
        // Presence of EBUSY is not enough; a co-occurring EPERM keeps it alerting.
        let mixed = rollup_ebusy(1, 1, 0);
        assert!(!runner_exit_is_file_lock(Some(2), None, false, &mixed));
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                Some(2),
                None,
                None,
                false,
                true,
                true,
                false,
                false,
                &mixed,
            ),
            RunnerExitDisposition::Alert
        );
    }

    #[test]
    fn a_seen_crash_keeps_an_ebusy_rollup_alerting() {
        // The sticky crash flag blocks file-lock suppression even with an
        // exclusively-EBUSY rollup.
        let ebusy = rollup_ebusy(1, 0, 0);
        assert!(!runner_exit_is_file_lock(Some(2), None, true, &ebusy));
        assert_eq!(
            classify_runner_exit_disposition_with_fault(
                Some(2),
                None,
                None,
                false,
                true,
                true,
                false,
                true,
                &ebusy,
            ),
            RunnerExitDisposition::Alert
        );
    }

    #[test]
    fn crash_signal_with_ebusy_rollup_still_alerts() {
        let ebusy = rollup_ebusy(1, 0, 0);
        for signal in [
            SIGSEGV_SIGNAL,
            SIGBUS_SIGNAL_MACOS,
            SIGBUS_SIGNAL_LINUX,
            SIGABRT_SIGNAL,
            SIGKILL_SIGNAL,
            SIGILL_SIGNAL,
        ] {
            assert!(is_crash_signal(Some(signal)), "signal {signal} is a crash");
            assert!(!runner_exit_is_file_lock(None, Some(signal), false, &ebusy));
            assert_eq!(
                classify_runner_exit_disposition_with_fault(
                    None,
                    Some(signal),
                    None,
                    false,
                    true,
                    true,
                    false,
                    false,
                    &ebusy,
                ),
                RunnerExitDisposition::Alert,
                "crash signal {signal} with EBUSY must still Alert"
            );
        }
    }

    #[test]
    fn a_non_crash_fatal_signal_with_ebusy_rollup_still_alerts() {
        // HQ-DESKTOP-5R review (Codex P1): is_crash_signal does not enumerate every
        // fatal signal (e.g. SIGQUIT=3, SIGFPE=8, SIGSYS=12/31). Because the
        // recognizer requires signal.is_none(), an exclusively-EBUSY run terminated
        // by ANY signal — a listed crash or not — stays alertable and is never
        // suppressed as a file lock. Under the pre-review `!is_crash_signal` gate
        // these would have classified FileLocked.
        let ebusy = rollup_ebusy(1, 0, 0);
        for signal in [3, 8, 12, 31] {
            assert!(
                !is_crash_signal(Some(signal)),
                "signal {signal} is deliberately outside the crash list"
            );
            assert!(!runner_exit_is_file_lock(None, Some(signal), false, &ebusy));
            assert_eq!(
                classify_runner_exit_disposition_with_fault(
                    None,
                    Some(signal),
                    None,
                    false,
                    true,
                    true,
                    false,
                    false,
                    &ebusy,
                ),
                RunnerExitDisposition::Alert,
                "non-crash fatal signal {signal} with EBUSY must still Alert"
            );
        }
    }

    #[test]
    fn windows_native_fault_code_with_ebusy_rollup_still_alerts() {
        // On Windows a native fault is reported in `code` with signal=None. It must
        // never be suppressed as file-lock, even alongside an exclusively-EBUSY rollup.
        let ebusy = rollup_ebusy(1, 0, 0);
        for fault in [0xC000_0005u32, 0xC000_0409u32] {
            let code = Some(fault as i32);
            assert!(is_windows_fault_exit(code), "0x{fault:08X} is a windows fault");
            assert!(!runner_exit_is_file_lock(code, None, false, &ebusy));
            assert_eq!(
                classify_runner_exit_disposition_with_fault(
                    code, None, None, false, true, true, false, false, &ebusy,
                ),
                RunnerExitDisposition::Alert,
                "windows fault 0x{fault:08X} with EBUSY must still Alert"
            );
        }
        // A conventional small exit code is Ordinary, not a fault → suppressible.
        assert!(!is_windows_fault_exit(Some(2)));
        assert!(runner_exit_is_file_lock(Some(2), None, false, &ebusy));
    }

    #[test]
    fn is_alertable_error_still_true_for_ebusy() {
        // The fix was made at the exit-disposition layer, NOT by widening the
        // per-error benign list: an EBUSY error is still an alertable error, so any
        // run that also produces a non-file-lock fault keeps surfacing.
        let ebusy = SyncErrorEvent {
            company: None,
            path: "(company)".to_string(),
            message: "EBUSY: resource busy or locked, read".to_string(),
        };
        assert!(is_alertable_error(&ebusy));
    }

    #[test]
    fn fault_layer_filelocked_only_replaces_a_base_alert() {
        // Full-input-lattice invariance with an EBUSY rollup in the set: the fault
        // layer may only convert a base Alert into DiskFull or FileLocked; every
        // other verdict is returned byte-identical, and each rewrite is gated by its
        // own recognizer.
        let rollups = [
            RunnerErrorRollup::default(),
            rollup_ebusy(1, 0, 0),   // exclusively file-locked
            rollup_ebusy(1, 1, 0),   // ebusy + eperm (mixed)
            rollup_of(1, 0, 0),      // exclusively disk-full
            rollup_of_ebusy_enospc(),// ebusy + enospc (neither exclusive)
            rollup_of(0, 0, 3),      // other-only
        ];
        let codes = [
            None,
            Some(0),
            Some(1),
            Some(2),
            Some(RUNNER_OPERATION_LOCKED_EXIT),
            Some(RUNNER_TRANSIENT_RETRY_EXIT),
            Some(243),
            Some(0xC000_0005u32 as i32),
        ];
        let signals = [None, Some(SIGTERM_SIGNAL), Some(SIGSEGV_SIGNAL), Some(SIGKILL_SIGNAL)];
        for &code in &codes {
            for &signal in &signals {
                for &saw_error in &[false, true] {
                    for &saw_alertable in &[false, true] {
                        for &node_old in &[false, true] {
                            for &saw_crash in &[false, true] {
                                for rollup in &rollups {
                                    let base = classify_runner_exit_disposition_with_cancellation(
                                        code, signal, None, false, saw_error, saw_alertable, node_old,
                                    );
                                    let fault = classify_runner_exit_disposition_with_fault(
                                        code, signal, None, false, saw_error, saw_alertable, node_old,
                                        saw_crash, rollup,
                                    );
                                    match fault {
                                        RunnerExitDisposition::DiskFull => {
                                            assert_eq!(base, RunnerExitDisposition::Alert);
                                            assert!(runner_exit_is_disk_exhaustion(
                                                code, signal, saw_crash, rollup
                                            ));
                                        }
                                        RunnerExitDisposition::FileLocked => {
                                            assert_eq!(base, RunnerExitDisposition::Alert);
                                            assert!(runner_exit_is_file_lock(
                                                code, signal, saw_crash, rollup
                                            ));
                                        }
                                        other => assert_eq!(
                                            other, base,
                                            "fault layer moved a non-fault verdict"
                                        ),
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn sync_file_locked_detail_is_fixed_and_content_safe() {
        // Names the condition, the one action, and the retry; never a path, an exit
        // code, the EBUSY token, a digit, or a specific file name.
        let m = SYNC_FILE_LOCKED_DETAIL;
        assert!(m.contains("HQ Sync"));
        assert!(m.contains("Sync again"));
        assert!(!m.contains("EBUSY"));
        assert!(!m.contains('/'));
        assert!(!m.chars().any(|c| c.is_ascii_digit()));
    }

    // ── Runner error SITE routing + attribution (HQ-DESKTOP-5M) ──────────────

    #[test]
    fn record_error_routes_every_producer_sentinel_to_its_own_site_never_the_file_arm() {
        // Each of the six hq-cloud error-event sentinels increments ONLY its own
        // site counter, is never given a path root, and never lands in the per-file
        // scope — the misrouting that made every unknown sentinel read
        // company:0,file:1 with path_roots=other:1.
        for (sentinel, token, scope_segment) in [
            ("(company)", "company:1", "company:1,file:0"),
            ("(discovery)", "discovery:1", "company:0,file:0,discovery:1"),
            ("(local-state)", "local_state:1", "company:0,file:0,local_state:1"),
            ("(runner)", "runner:1", "company:0,file:0,runner:1"),
            ("(scope)", "scope:1", "company:0,file:0,scope:1"),
            // The (auth) site renders `identity` (denylist-safe), never `auth`.
            ("(auth)", "identity:1", "company:0,file:0,identity:1"),
        ] {
            let mut totals = RunTotals::default();
            totals.record_error(&SyncErrorEvent {
                company: None,
                path: sentinel.to_string(),
                message: "state store preflight failed".to_string(),
            });
            assert_eq!(
                totals.runner_error_sites.tag_value().as_deref(),
                Some(token),
                "site token for {sentinel}"
            );
            assert_eq!(
                totals.runner_error_scope().as_deref(),
                Some(scope_segment),
                "scope split for {sentinel}"
            );
            assert_eq!(
                totals.runner_error_path_roots.tag_value(),
                None,
                "sentinel {sentinel} must never be given a path root"
            );
        }
        // A genuine relative path still lands in the per-file arm with its path root.
        let mut file_totals = RunTotals::default();
        file_totals.record_error(&SyncErrorEvent {
            company: Some("acme".to_string()),
            path: "knowledge/secret.md".to_string(),
            message: "download skipped: local parent escaped the sync root".to_string(),
        });
        assert_eq!(
            file_totals.runner_error_sites.tag_value().as_deref(),
            Some("file:1")
        );
        assert_eq!(
            file_totals.runner_error_scope().as_deref(),
            Some("company:0,file:1")
        );
        assert_eq!(
            file_totals.runner_error_path_roots.tag_value().as_deref(),
            Some("knowledge:1")
        );
    }

    #[test]
    fn runner_error_scope_prefix_is_byte_identical_for_company_and_file_only() {
        let mut totals = RunTotals::default();
        totals.record_error(&SyncErrorEvent {
            company: Some("a".to_string()),
            path: "(company)".to_string(),
            message: "x".to_string(),
        });
        for path in ["knowledge/a.md", "repos/b"] {
            totals.record_error(&SyncErrorEvent {
                company: Some("a".to_string()),
                path: path.to_string(),
                message: "y".to_string(),
            });
        }
        // Exactly the pre-change rendering — no new segment appears when only company
        // and file errors were recorded, so any dashboard/alert parsing the prefix is
        // unaffected.
        assert_eq!(
            totals.runner_error_scope().as_deref(),
            Some("company:1,file:2")
        );
    }

    #[test]
    fn the_observed_hq_desktop_5m_local_state_exit_is_now_fully_attributed() {
        // The reported population: exactly ONE error event per run, a (local-state)
        // preflight failure shipping a bare err.message. On base every axis read
        // unknown/other and the scope split lied company:0,file:1. Now the site names
        // it and nothing is misrouted to the file/path-root arm.
        let mut totals = RunTotals::default();
        totals.record_error(&SyncErrorEvent {
            company: None,
            path: "(local-state)".to_string(),
            message: "journal state store is unreadable".to_string(),
        });
        assert_eq!(
            totals.runner_error_sites.tag_value().as_deref(),
            Some("local_state:1")
        );
        assert_eq!(totals.runner_error_sites.fingerprint_token(), "local_state");
        assert_eq!(
            totals.runner_error_scope().as_deref(),
            Some("company:0,file:0,local_state:1")
        );
        // The sentinel is never fed to classify_runner_path_root: the `other:1`
        // pollution is gone.
        assert_eq!(totals.runner_error_path_roots.tag_value(), None);
        // A bare err.message carries no leading CamelCase identity, so it stays an
        // honest unknown_unnamed with no signature — the message really is nameless.
        assert_eq!(
            totals.runner_error_causes.tag_value().as_deref(),
            Some("unknown_unnamed:1")
        );
        assert_eq!(totals.runner_error_cause_signature.tag_value(), None);
    }

    #[test]
    fn runner_stack_shape_for_exit_prefers_the_embedded_runner_stack_over_an_all_redacted_tail() {
        use crate::runner_error_shape::{classify_runner_stack_input, RunnerStackInput};
        // A (runner) uncaught rejection embeds its err.stack INSIDE the message; the
        // stderr tail is a flood of ndjson records (all_redacted). The exit now
        // reports the shaped embedded stack instead of all_redacted, while
        // runner_stack_input still reports what the TAIL was.
        let stack_message = "VaultShardError: shard 7 unreadable\n    at loadShard (node:internal/modules/cjs/loader:120:5)\n    at Module._compile (node:internal/modules/cjs/loader:1560:14)";
        let mut totals = RunTotals::default();
        totals.record_error(&SyncErrorEvent {
            company: None,
            path: "(runner)".to_string(),
            message: stack_message.to_string(),
        });
        let tail = vec![
            r#"{"type":"error","path":"(runner)","message":"boom"}"#.to_string(),
            "some plain trailing line".to_string(),
        ];
        // The tail on its own is honestly all_redacted and mixed.
        assert_eq!(runner_stack_shape(&tail).shape, "all_redacted");
        assert_eq!(classify_runner_stack_input(&tail), RunnerStackInput::Mixed);
        let shape = runner_stack_shape_for_exit(&totals, &tail);
        assert_ne!(shape.shape, "all_redacted", "embedded (runner) stack must be preferred");
        assert!(
            shape.redacted_frames < shape.depth,
            "a recognised stack has fewer redacted frames than its depth"
        );
        assert!(
            shape.shape.contains("node_cjs_loader"),
            "recognised node frames shape it: {}",
            shape.shape
        );
        // Content safety: the shape/signature never carry a message byte.
        for forbidden in ["VaultShardError", "loadShard", "shard"] {
            assert!(
                !shape.shape.contains(forbidden) && !shape.signature.contains(forbidden),
                "embedded shape leaked {forbidden:?}"
            );
        }

        // A (local-state) message with no frames stays honestly all_redacted: no
        // embedded shape is stored, so the tail's all_redacted is authoritative.
        let mut ls_totals = RunTotals::default();
        ls_totals.record_error(&SyncErrorEvent {
            company: None,
            path: "(local-state)".to_string(),
            message: "state store preflight failed".to_string(),
        });
        assert_eq!(ls_totals.runner_embedded_stack_shape(), None);
        assert_eq!(
            runner_stack_shape_for_exit(&ls_totals, &tail).shape,
            "all_redacted"
        );
    }

    #[test]
    fn re_scoping_the_auth_sentinel_leaves_the_alert_and_reauth_signals_unchanged() {
        // Moving the (auth) error-event sentinel out of the per-file arm must not
        // change alerting, suppression, or the re-authentication signal: those read
        // the message (and the auth-error protocol event), never err.path.
        let auth_err = SyncErrorEvent {
            company: None,
            path: "(auth)".to_string(),
            message: "AccessDenied http=403 forbidden".to_string(),
        };
        let file_auth = SyncErrorEvent {
            company: None,
            path: "knowledge/x.md".to_string(),
            message: "AccessDenied http=403 forbidden".to_string(),
        };
        // is_alertable_error reads only the message, so the verdict is identical
        // whether the path is the (auth) sentinel or a plain file path.
        assert_eq!(is_alertable_error(&auth_err), is_alertable_error(&file_auth));
        assert!(is_alertable_error(&auth_err));

        let mut totals = RunTotals::default();
        totals.record_error(&auth_err);
        // The AUTH class rollup still names it from the message, independent of scope,
        assert_eq!(totals.runner_error_rollup.fingerprint_token(), "auth");
        // the alertable flag is set from the message,
        assert!(totals.saw_alertable_error);
        // and record_error never sets the reauth signal (that is the AuthError
        // protocol event's job), so it stays false.
        assert!(!totals.saw_auth_error);
        // The site is attributed to the auth sentinel, spelled `identity` (never the
        // `auth` substring Sentry's @password:filter eats), and never `file`.
        assert_eq!(
            totals.runner_error_sites.tag_value().as_deref(),
            Some("identity:1")
        );
        assert_eq!(
            totals.runner_error_scope().as_deref(),
            Some("company:0,file:0,identity:1")
        );
    }
}
