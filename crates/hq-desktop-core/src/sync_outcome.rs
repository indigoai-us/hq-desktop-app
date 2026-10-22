use std::collections::HashSet;
use std::io::ErrorKind;
use std::time::Duration;

use crate::events::{SyncCompleteEvent, SyncErrorEvent, SyncEvent};
use crate::runner_error_shape::{
    classify_runner_error_cause, classify_runner_error_site, PreRunnerCause, PreRunnerCauseRollup,
    PreRunnerSite, PreRunnerSiteRollup, RunnerErrorCause, RunnerErrorCauseRollup,
    RunnerErrorCauseSignatureRollup, RunnerErrorHttpRollup, RunnerErrorHttpStatus,
    RunnerErrorPathRootRollup, RunnerErrorResidualSignatureRollup, RunnerErrorShapeRollup,
    RunnerErrorSite, RunnerErrorSiteRollup, RunnerErrorUnknownProfileRollup,
};
use crate::runner_exit_record::{parse_runner_exit_line, RunnerExitRecord};
use crate::uploads_paused::UploadsPassObservation;
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
    /// Latest valid bounded runner-exit diagnostic, when emitted by a newer
    /// runner. The parser retains only an integer and a closed reason enum.
    runner_exit_record: Option<RunnerExitRecord>,
    /// What this pass said about uploads per company: plan-limit notices,
    /// per-company completions, and companies that uploaded a file. Settles
    /// the "uploads paused" state at `AllComplete` (hard-stop-readiness
    /// US-019). Before this, a pass whose uploads a plan limit refused counted
    /// as a clean sync.
    pub uploads_pass: UploadsPassObservation,
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
    /// Content-safe STRUCTURAL profile counts of the `unknown_unnamed` cause residual
    /// (HQ-DESKTOP-61/62): the message that carried no leading identity to name and
    /// no `runner_error_cause_signature`, previously a dead end. Records only what the
    /// unmatched message structurally was (`key_value_led`/`lower_prose`/…) — a
    /// compile-time token, never a runner byte. Fed ONLY from the `UnknownUnnamed`
    /// branch of `record_error`; a DEDICATED, non-fingerprint rollup.
    pub runner_error_unknown_profiles: RunnerErrorUnknownProfileRollup,
    /// Content-safe correlator for the `unknown_unnamed` cause residual
    /// (HQ-DESKTOP-61/62): the SHA-256 hex12 of a gated, machine-decodable signing
    /// input an unnamed residual can still carry (an unlisted `code=`/`cause=`/
    /// `syscall=` identifier, else a >=2-word ASCII skeleton). The sibling to
    /// `runner_error_cause_signature` — it correlates the residual that axis leaves
    /// blank, without widening it. Never a runner byte; fed ONLY from the
    /// `UnknownUnnamed` branch of `record_error`; a DEDICATED, non-fingerprint rollup.
    pub runner_error_residual_signature: RunnerErrorResidualSignatureRollup,
    /// Content-safe per-site counts of the runner error events seen this pass —
    /// the closed `RunnerErrorSite` vocabulary (`company`/`discovery`/`local_state`/
    /// `runner`/`scope`/`auth`/`file`). This is the single source of truth for BOTH
    /// the `runner_error_sites` rollup tag / fingerprint token AND the
    /// `runner_error_scope` split, so the two can never disagree. It names WHICH
    /// runner failure site produced the exit — the axis every one of the six
    /// HQ-DESKTOP-5M events lacked. Every token is chosen in code, never a path byte.
    pub runner_error_sites: RunnerErrorSiteRollup,
    /// Content-safe per-run counts of PRE-RUNNER (first-push phase) failure SITES
    /// (HQ-DESKTOP-64) — a fault the desktop observed BEFORE the runner spawned,
    /// which never reaches the runner-output writers above. This is a DEDICATED
    /// rollup, deliberately NOT a fingerprint input, so recording pre-runner
    /// evidence never regroups a runner-termination issue. Written ONLY by
    /// `record_pre_runner_failure`.
    pub pre_runner_failures: PreRunnerSiteRollup,
    /// Content-safe per-run counts of PRE-RUNNER failure CAUSES (HQ-DESKTOP-64), the
    /// companion to `pre_runner_failures`. Also a DEDICATED, non-fingerprint rollup;
    /// the typed HTTP status a pre-runner failure carried is folded into the shared,
    /// fingerprint-safe `runner_error_http` rollup instead. Written ONLY by
    /// `record_pre_runner_failure`.
    pub pre_runner_causes: PreRunnerCauseRollup,
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

#[cfg(test)]
mod sentry_path_tag_tests {
    use super::{remember_runner_exit_error, sentry_path_tag};
    use std::sync::Mutex;

    #[test]
    fn sentry_path_tags_keep_only_lowercase_sentinel_tokens() {
        assert_eq!(sentry_path_tag("(runner)"), "(runner)");
        assert_eq!(sentry_path_tag("(telemetry-events)"), "(telemetry-events)");
        for path in [
            "companies/acme/knowledge/plan.md",
            "/srv/hq/companies/acme/plan.md",
            r"C:\Users\Ada\HQ\plan.md",
            r"\\server\share\HQ\plan.md",
        ] {
            assert_eq!(sentry_path_tag(path), "[Filtered]", "{path}");
        }
        for invalid in ["(Runner)", "()", "(bad_value)", "(runner/path)"] {
            assert_eq!(sentry_path_tag(invalid), "[Filtered]", "{invalid}");
        }
    }

    #[test]
    fn runner_exit_error_keeps_recognized_class_after_unknown_candidate() {
        let current = Mutex::new(None);
        remember_runner_exit_error(&current, Some("journal-invalid-payload"));
        remember_runner_exit_error(&current, Some("unknown"));
        assert_eq!(
            *current.lock().unwrap_or_else(|error| error.into_inner()),
            Some("journal-invalid-payload")
        );

        let empty = Mutex::new(None);
        remember_runner_exit_error(&empty, Some("unknown"));
        assert_eq!(
            *empty.lock().unwrap_or_else(|error| error.into_inner()),
            Some("unknown")
        );
    }
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
                self.uploads_pass.completed.insert(c.company.clone());
            }
            SyncEvent::PlanLimit(notice) => {
                // Only a link on a host hq-pro returns is kept; the notice
                // itself counts either way.
                self.uploads_pass.plan_limited.insert(
                    notice.company.clone(),
                    crate::plan_limit::approved_plan_upgrade_url(&notice.upgrade_url),
                );
            }
            SyncEvent::Progress(p)
                if p.direction.as_deref() == Some("up") && p.deleted != Some(true) =>
            {
                self.uploads_pass.uploaded.insert(p.company.clone());
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
        // Structural profile + residual signature for an `unknown_unnamed` residual
        // ONLY (HQ-DESKTOP-61/62): the residual the two axes above leave a dead end —
        // classified `unknown_unnamed`, so no cause name and no cause-signature. These
        // two DEDICATED rollups make the next such exit self-describing (structure +
        // an offline-decodable correlator). Gated on the SAME classifier the cause
        // axis uses, appended AFTER the existing feeds. This block writes NEITHER
        // runner_error_rollup / runner_error_causes / runner_error_sites (the three
        // exit-fingerprint rollups, elements 4/5/6) NOR any saw_* disposition flag, so
        // for an otherwise-identical run the exit fingerprint AND disposition are equal
        // with and without residual evidence recorded (both pinned by regression tests).
        if classify_runner_error_cause(&err.message) == RunnerErrorCause::UnknownUnnamed {
            self.runner_error_unknown_profiles.record(&err.message);
            self.runner_error_residual_signature.record(&err.message);
        }
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

    /// Record a PRE-RUNNER (first-push phase) failure the desktop observed BEFORE
    /// the runner spawned (HQ-DESKTOP-64). Such a fault — e.g. a first-push
    /// `/sts/vend-child` HTTP 403 — is captured as its own Sentry event and never
    /// reaches `RunTotals` through the runner-output writers, so an exit it preceded
    /// shipped with no pre-runner evidence and no attribution.
    ///
    /// This writes ONLY:
    ///   * the two DEDICATED pre-runner rollups (`pre_runner_failures`,
    ///     `pre_runner_causes`), which are NOT fingerprint inputs, and
    ///   * the shared, fingerprint-safe `runner_error_http` rollup — via the typed
    ///     [`RunnerErrorHttpRollup::record_status`] entry point, bypassing the
    ///     untrusted-prose classifier — when a typed status is present.
    ///
    /// It deliberately never touches `saw_error` / `saw_alertable_error` /
    /// `saw_node_too_old`, so the exit disposition is unchanged, and never touches
    /// `runner_error_rollup` / `runner_error_causes` / `runner_error_sites` (the
    /// three rollups the exit fingerprint reads, elements 4/5/6), so for an
    /// otherwise-identical run the exit fingerprint is equal with and without
    /// pre-runner evidence recorded. Both invariants are pinned by regression tests.
    pub fn record_pre_runner_failure(
        &mut self,
        site: PreRunnerSite,
        status: Option<u16>,
        cause: PreRunnerCause,
    ) {
        self.pre_runner_failures.record(site);
        self.pre_runner_causes.record(cause);
        if let Some(status) = status {
            self.runner_error_http
                .record_status(RunnerErrorHttpStatus::from_status(status));
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
        if let Some(record) = parse_runner_exit_line(line) {
            self.runner_exit_record = Some(record);
        }
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

    /// The latest parsed runner-exit diagnostic, absent for older runners or
    /// when no valid record was written.
    pub fn runner_exit_record(&self) -> Option<RunnerExitRecord> {
        self.runner_exit_record
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
        self.heap_oom
            .as_ref()
            .and_then(|evidence| evidence.used_total_mb)
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
    if ordinal.is_empty() || ordinal.len() > 3 || !ordinal.bytes().all(|byte| byte.is_ascii_digit())
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

/// Build a content-safe [`RunnerStackShape`] from an ordered list of native-frame
/// symbols, exactly as the macOS heap-OOM stderr path builds one (the SAME
/// [`heap_oom_frame_token`] allow-list and SHA-256 digest discipline). Used by the
/// Node diagnostic-report parser (this reopen, HQ-DESKTOP-5W) so a report-derived
/// shape and its 16-hex signature are constructed identically to today's stderr
/// path. The symbols themselves NEVER leave: only the fixed shape tokens and the
/// digest do, so a frame symbol carrying a path or hostile bytes yields only
/// allow-listed tokens. A stack in which nothing matched the allow-list (empty, or
/// every frame collapsed to `anon`) reports the honest `all_redacted`/`unknown`
/// shape, never a string of `anon` tokens or an empty shape with a real digest —
/// the same honesty contract [`runner_stack_shape`] holds.
pub fn runner_stack_shape_from_native_symbols(symbols: &[String]) -> RunnerStackShape {
    if symbols.is_empty() {
        return RunnerStackShape {
            shape: "all_redacted".to_string(),
            depth: 0,
            redacted_frames: 0,
            signature: "unknown".to_string(),
        };
    }
    let shape = heap_oom_stack_shape(symbols);
    if shape
        .shape
        .split('>')
        .all(|token| token == HEAP_OOM_ANON_FRAME)
    {
        return RunnerStackShape {
            shape: "all_redacted".to_string(),
            depth: shape.depth,
            redacted_frames: shape.depth,
            signature: "unknown".to_string(),
        };
    }
    shape
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

/// True when `haystack_lower` (already lowercased) contains `needle` as a bounded
/// token — bordered on each side by the start/end of the string or by a byte that
/// `is_word_byte` rejects. The shared boundary scanner behind both the errno and
/// the auth-marker matchers, so their "is this a standalone token or a fragment
/// inside a longer word?" decision can never drift apart. The caller chooses what
/// counts as "inside a token" via `is_word_byte`.
fn message_contains_bounded_token(
    haystack_lower: &str,
    needle: &str,
    is_word_byte: impl Fn(u8) -> bool,
) -> bool {
    let bytes = haystack_lower.as_bytes();
    let mut search_from = 0;
    while let Some(offset) = haystack_lower[search_from..].find(needle) {
        let index = search_from + offset;
        let before_ok = index == 0 || !is_word_byte(bytes[index - 1]);
        let after = index + needle.len();
        let after_ok = after >= bytes.len() || !is_word_byte(bytes[after]);
        if before_ok && after_ok {
            return true;
        }
        search_from = index + 1;
    }
    false
}

/// True when `haystack` (already lowercased) contains `errno` as a bounded token
/// — bordered by the start/end of the string or a non-alphanumeric byte on each
/// side. `describeError` renders a Node errno as its own token (`EEXIST:`,
/// `code=EEXIST`, ` EEXIST `), so a bounded match still catches every real
/// rendering while refusing an errno spelled INSIDE an ordinary word — e.g.
/// `eexist` inside `preexisting`, which a bare `contains` would misclassify.
fn message_contains_errno_token(haystack_lower: &str, errno: &str) -> bool {
    message_contains_bounded_token(haystack_lower, errno, |byte| byte.is_ascii_alphanumeric())
}

/// Auth/identity vocabulary matched as a plain substring. Each token is specific
/// enough that it never occurs incidentally inside an unrelated path segment or
/// identifier: `authentic`/`authoriz`/`authoris` are absent from `authors`, and
/// `oauth`/`cognito`/`forbidden`/`auth-error` carry no path-segment collision. A
/// substring match therefore keeps genuine `authentication`/`authorization` prose
/// AND the runner's `auth-error` protocol discriminator
/// (`{"type":"auth-error",…}`, the record `runner_stderr_needs_reauth` acts on)
/// classified as identity failures — the full-word forms bounded matching would
/// otherwise drop.
const AUTH_MARKER_SUBSTRINGS: [&str; 7] = [
    "oauth",
    "cognito",
    "forbidden",
    "authentic",
    "authoriz",
    "authoris",
    "auth-error",
];

/// The short auth markers that DO occur incidentally inside ordinary path segments
/// and identifiers (`auth` in `authors/`, `token` in `token-providers` or
/// `tokenCount`). These match only as bounded tokens: alphanumerics AND the
/// connectors that join path segments and package / identifier names
/// (`- _ . / \ @`) all count as "inside a token", so a marker buried in a path
/// segment, a package name, or a camelCase key is refused, while a marker that
/// stands as its own word (delimited by whitespace, prose punctuation, or the
/// string edge) still classifies `Auth`. An unbounded `contains` over these two
/// was the HQ-DESKTOP-67 miscue: 96 path-led stderr lines rendered the breadcrumb
/// `identity` on an in-word match. This mirrors [`message_contains_errno_token`]'s
/// fix for `eexist` inside `preexisting`.
const AUTH_MARKER_BOUNDED: [&str; 2] = ["auth", "token"];

/// True when `haystack_lower` carries a genuine identity/authorization signal: an
/// unambiguous [`AUTH_MARKER_SUBSTRINGS`] token anywhere, or a short
/// [`AUTH_MARKER_BOUNDED`] marker standing as its own token.
fn message_contains_auth_marker(haystack_lower: &str) -> bool {
    if AUTH_MARKER_SUBSTRINGS
        .iter()
        .any(|marker| haystack_lower.contains(marker))
    {
        return true;
    }
    AUTH_MARKER_BOUNDED.iter().any(|marker| {
        message_contains_bounded_token(haystack_lower, marker, |byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/' | b'\\' | b'@')
        })
    })
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
        // … the ~6.16.11 pin's addition — truncated write-credential scope is
        // a policy/issuance fault with no unambiguous class analogue, so the
        // keyword fallback stays authoritative …
        | RunnerErrorCause::VaultCredentialScope
        // … the ~6.16.23 pin's addition — a sync-manifest contract violation is
        // a runner-side validation fault, not an auth/network/errno one, so the
        // keyword fallback stays authoritative …
        | RunnerErrorCause::SyncManifestContract
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
        // … the ~6.18.5 pin's additions — realtime admission deadline and drain
        // burst are coordinator scheduling faults, the Object Lock checksum
        // refusal is a request-shape fault, a stalled download body is a
        // retryable per-object stall rather than a connection errno, and the
        // realtime device cap is an account limit; none maps unambiguously to a
        // class, so the keyword fallback stays authoritative …
        | RunnerErrorCause::RealtimeAdmissionTimeout
        | RunnerErrorCause::RealtimeDrainBurst
        | RunnerErrorCause::ObjectLockChecksumRequired
        | RunnerErrorCause::ObjectBodyIdleTimeout
        | RunnerErrorCause::SyncDeviceLimit
        // … the ~6.18.51 pin's additions — a tombstone full-reconcile refusal
        // is a server-state fault and a refused pull symlink target is a
        // per-file policy refusal; neither maps unambiguously to a class, so
        // the keyword fallback stays authoritative …
        | RunnerErrorCause::TombstoneFullReconcileRequired
        | RunnerErrorCause::UnsafeSymlinkTarget
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
    } else if message_contains_auth_marker(&msg) {
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
    /// Reporting-only stderr cause. Unlike `class`, this also distinguishes
    /// expected owner-busy and lease-lost messages; neither is a fatal class.
    pub stderr_cause: &'static str,
    /// Owner lease outcome explicitly evidenced by the stderr line.
    pub watch_owner_result: &'static str,
    /// Process attribution evidenced by this stderr classifier.
    pub exit_producer: &'static str,
}

/// Bounded, content-safe holder identity emitted by hq-cloud on watch-owner
/// contention. Each field is copied only after it passes its own shape check;
/// a field that is missing (runners before hq-cloud #837 print only owner and
/// pid) or fails its check reads `unknown`, so arbitrary command lines and paths
/// never leave the process and the remaining evidence is never dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchOwnerHolderFields {
    pub owner: String,
    pub pid: String,
    pub process_name: &'static str,
    pub started_at: String,
}

const UNKNOWN_HOLDER_FIELD: &str = "unknown";

/// Parses the holder fields of an hq-cloud owner-refusal line. Returns `None`
/// only when `line` is not a refusal line.
pub fn parse_watch_owner_holder_fields(line: &str) -> Option<WatchOwnerHolderFields> {
    let (_, rest) = line.split_once("already owned for this HQ root (")?;
    let fields = rest.split_once(");").map_or(rest, |(fields, _)| fields);
    let mut holder = WatchOwnerHolderFields {
        owner: UNKNOWN_HOLDER_FIELD.to_string(),
        pid: UNKNOWN_HOLDER_FIELD.to_string(),
        process_name: UNKNOWN_HOLDER_FIELD,
        started_at: UNKNOWN_HOLDER_FIELD.to_string(),
    };
    for field in fields.split(", ") {
        let Some((key, value)) = field.split_once('=') else {
            continue;
        };
        match key {
            "owner"
                if !value.is_empty()
                    && value.len() <= 64
                    && value.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                    }) =>
            {
                holder.owner = value.to_string()
            }
            "pid" => {
                if let Some(pid) = value.parse::<u32>().ok().filter(|pid| *pid > 0) {
                    holder.pid = pid.to_string();
                }
            }
            "process" if value == "sync-runner" => holder.process_name = "sync-runner",
            "startedAt" if is_bounded_utc_timestamp(value) => holder.started_at = value.to_string(),
            _ => {}
        }
    }
    Some(holder)
}

fn is_bounded_utc_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    (20..=24).contains(&bytes.len())
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
        && bytes.last() == Some(&b'Z')
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7) && *byte == b'-'
                || index == 10 && *byte == b'T'
                || matches!(index, 13 | 16) && *byte == b':'
                || index == bytes.len() - 1 && *byte == b'Z'
                || index == 19 && *byte == b'.'
                || byte.is_ascii_digit()
        })
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
pub const RUNNER_ASSERT_SOURCES: &[&str] = &[
    "libuv_win_async",
    "libuv_unix_core",
    "libuv_handle",
    "other",
];

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
        if matches!(
            *token,
            "libuv_win_async" | "libuv_unix_core" | "libuv_handle"
        ) && lowered.contains(&marker.to_ascii_lowercase())
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
            Some((path, after_line)) => (
                runner_assert_source_token(path),
                parse_leading_i64(after_line),
            ),
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
    let (stderr_cause, watch_owner_result, exit_producer) =
        classify_runner_exit_diagnostics(line, class);
    if class == RunnerFatalClass::LibuvFatalSyscall {
        if let Some((syscall, errno)) = parse_libuv_fatal_syscall(line) {
            return RunnerFatalSignature {
                class,
                syscall: Some(syscall),
                errno: Some(errno),
                stderr_cause,
                watch_owner_result,
                exit_producer,
            };
        }
    }
    RunnerFatalSignature {
        class,
        syscall: None,
        errno: None,
        stderr_cause,
        watch_owner_result,
        exit_producer,
    }
}

fn classify_runner_exit_diagnostics(
    line: &str,
    class: RunnerFatalClass,
) -> (&'static str, &'static str, &'static str) {
    let lowered = line.to_ascii_lowercase();
    if lowered.contains("hq-sync-runner already owned") {
        return ("already_owned", "busy", "runner");
    }
    if lowered.contains("watch-owner lease lost") || lowered.contains("watch owner lease lost") {
        return ("owner_lease_lost", "lost", "runner");
    }
    let stderr_cause = if class.seen() {
        class.as_str()
    } else {
        "other"
    };
    // npm's own prefix is the classifier's explicit relay marker. Other Node or
    // launcher failures remain unknown until protocol output or a Node report
    // identifies which descendant supplied the status.
    let exit_producer = if class == RunnerFatalClass::NpmInstallRelay {
        "launcher"
    } else {
        "unknown"
    };
    (stderr_cause, "unknown", exit_producer)
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

    /// Add one message to the fixed-vocabulary class rollup. Exposes the same
    /// classifier to the Windows app without duplicating its vocabulary.
    pub fn record_message(&mut self, message: &str) {
        self.record(message);
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

/// Keep only the fixed sentinel vocabulary used for Sentry path tags. A real
/// file or vault path is never suitable as a telemetry dimension.
pub fn sentry_path_tag(path: &str) -> String {
    let Some(token) = path
        .strip_prefix('(')
        .and_then(|value| value.strip_suffix(')'))
    else {
        return "[Filtered]".to_string();
    };
    if !token.is_empty()
        && token
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        path.to_string()
    } else {
        "[Filtered]".to_string()
    }
}

/// Retain the most informative recognized runner error class seen in a run.
/// An `unknown` candidate only fills an empty slot, so a later generic error
/// cannot erase an earlier fixed-vocabulary class.
pub fn remember_runner_exit_error(
    current: &std::sync::Mutex<Option<&'static str>>,
    candidate: Option<&'static str>,
) {
    let Some(candidate) = candidate else { return };
    let mut current = current.lock().unwrap_or_else(|error| error.into_inner());
    if candidate != "unknown" || current.is_none() {
        *current = Some(candidate);
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
/// A watch-mode runner refused because a live owner already holds this root.
pub const RUNNER_ALREADY_OWNED_EXIT: i32 = 20;

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

/// Bounded meaning for a runner exit code. This is diagnostic metadata only;
/// it must not affect the exit disposition or retry policy.
pub fn runner_exit_meaning(code: Option<i32>, saw_auth_error: bool) -> &'static str {
    match (code, saw_auth_error) {
        (Some(18), true) => "identity_required_pass",
        (Some(18), false) => "exit_18_unattributed",
        (Some(_), _) => "other",
        (None, _) => "no_exit_code",
    }
}

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

/// Stable, content-safe class for grouping auto-sync watcher exits. Evidence-backed
/// memory deaths converge across host-specific exit encodings; otherwise specific
/// Windows statuses and POSIX termination signals retain their class, a Node fatal
/// takes the class when no more specific OS status is present, and remaining exits
/// use `other` rather than embedding a raw code in the Sentry fingerprint.
pub fn watcher_exit_class(
    code: Option<i32>,
    signal: Option<i32>,
    node_fatal: bool,
    memory_attributed: bool,
) -> &'static str {
    if code == Some(RUNNER_ALREADY_OWNED_EXIT) && signal.is_none() {
        "already_owned"
    } else if memory_attributed {
        "runner_memory"
    } else if code == Some(0xC000_0005u32 as i32) {
        "access_violation"
    } else if code == Some(0xC000_0409u32 as i32) {
        "stack_buffer_overrun"
    } else if code == Some(WINDOWS_SESSION_TERMINATE_EXIT) {
        "dbg_terminate"
    } else if signal == Some(SIGTERM_SIGNAL) {
        "sigterm"
    } else if signal == Some(SIGKILL_SIGNAL) {
        "sigkill"
    } else if code == Some(-1) {
        "minus_one"
    } else if node_fatal {
        "node_fatal"
    } else {
        "other"
    }
}

/// Preserve a recognized environmental runner cause in watcher grouping only
/// when no stronger OS or sticky crash evidence is present. Unknown fatal classes,
/// Windows native faults, and runs with any observed genuine crash keep their
/// existing exit class.
pub fn watcher_exit_class_with_fatal_cause(
    code: Option<i32>,
    signal: Option<i32>,
    node_fatal: bool,
    memory_attributed: bool,
    saw_genuine_crash_fatal: bool,
    runner_fatal_class: &str,
) -> &'static str {
    let exit_class = watcher_exit_class(code, signal, node_fatal, memory_attributed);
    if exit_class == "other"
        && signal.is_none()
        && !is_windows_fault_exit(code)
        && !saw_genuine_crash_fatal
        && runner_fatal_class == RunnerFatalClass::DiskFull.as_str()
    {
        "disk_full"
    } else {
        exit_class
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
    if latch.suppresses() || attribution == Some(WindowsTerminatorAttribution::SessionEndObserved) {
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
/// - `Absent` — "the OS was verifiably not tearing down" — may rest ONLY on the
///   one source that can actually observe a user sign-out: `SM_SHUTTINGDOWN`.
///   BOTH samples must be an explicit `No`; an `Unavailable` sample means "could
///   not ask" and is never a negative. The empty System channel is a SUPPORTING
///   condition, not the load-bearing one — its query covers shutdown/restart
///   providers only (User32 1074 / Kernel-General 13 / Kernel-Power 109) and a
///   logoff writes none of them, so an empty channel is not itself evidence that
///   no session ended. This is why `Absent` alone no longer silences anything:
///   it only makes the honest `UnattributedNoTeardown` tag accurate, while the
///   per-run reporting boundary decides whether to send.
/// - Anything else — an unreadable channel, an unavailable flag, a bracketing
///   *initiation-only* record, any mix short of two explicit `No` flags — is
///   `Unknown`, which the caller treats exactly like today's behaviour. The
///   record class is still stamped on the diagnostics for the next round.
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
    // The load-bearing negative: only the sign-out-capable flag counts, and only
    // when BOTH samples explicitly read `No` (never `Unavailable`).
    let both_flags_explicit_no = reading.shuttingdown_at_exit == TeardownShuttingDown::No
        && reading.shuttingdown_at_resolve == TeardownShuttingDown::No;
    if both_flags_explicit_no && reading.log == TeardownLogReading::None {
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

/// Whether a deferred session-terminate exit carried POSITIVE OS session-end
/// evidence at resolution. There are exactly three independent positive sources,
/// any one of which suffices —
///
/// 1. the observer saw the committed session-end message (`SessionEndObserved`);
/// 2. a durable latch was set contemporaneously from a committed
///    `WM_ENDSESSION` / same-session WTS logoff / the app's own session-end exit
///    branch ([`SessionEndLatchReading::suppresses`]); or
/// 3. the pull-based probe caught the OS mid-teardown (`Confirmed`).
///
/// This is the confirmed-session-end predicate the resolution and the per-run
/// escalation counter both key off, kept in one place so "was this a real
/// session end" has a single definition.
pub fn deferred_session_end_confirmed(
    attribution: WindowsTerminatorAttribution,
    verdict: WindowsTeardownVerdict,
    latch: SessionEndLatchReading,
) -> bool {
    attribution == WindowsTerminatorAttribution::SessionEndObserved
        || latch.suppresses()
        || verdict == WindowsTeardownVerdict::Confirmed
}

/// Whether an UNCONFIRMED session-terminate watcher exit should escalate to a
/// Sentry capture, given how many such exits (INCLUDING this one, 1-based) have
/// resolved in a row within the current app run without any confirmed session
/// end or intervening ordinary exit.
///
/// `0x40010004` (`DBG_TERMINATE_PROCESS`) is an externally-supplied exit code the
/// child cannot produce itself, so the FIRST unconfirmed session-terminate exit
/// per app run is the benign Windows sign-out signature — every reported event in
/// this cluster carries `consecutive failure #1`, i.e. exactly one per run — and
/// stays silent. A SECOND one within the same run cannot be a session end (the
/// app is demonstrably still alive to observe it), so it escalates on its own
/// fingerprint. The threshold reuses [`is_capture_milestone`] beyond the second
/// so a genuinely repeating external killer alerts on the 2nd, 4th, 8th … rather
/// than on every single repeat — a bounded capture, never a capture loop.
pub fn unconfirmed_session_terminate_escalates(run_count: u32) -> bool {
    run_count >= 2 && is_capture_milestone(run_count)
}

/// Resolve a deferred session-end capture against the re-read attribution, the
/// pull-based teardown verdict, the durable session-end latch, and the count of
/// unconfirmed session-terminate exits in this app run (INCLUDING this one).
///
/// Fail-closed and, by construction, quiet on the benign case:
///
/// - positive OS session-end evidence ([`deferred_session_end_confirmed`]) always
///   DROPS the held alert — a confirmed sign-out/shutdown is not a watcher fault;
/// - otherwise the exit is UNCONFIRMED. The default resolution is now `Drop`,
///   because a single externally-supplied `DBG_TERMINATE_PROCESS` per app run is
///   the ordinary sign-out shape and the alert's own claim ("exited unexpectedly
///   … consecutive failure #N") is never true of it. Only a repeat within the
///   same run ([`unconfirmed_session_terminate_escalates`]) captures, so a real
///   external killer still surfaces while an ordinary logoff never does.
///
/// The local log, breadcrumb, and every tag/extra are still produced for a
/// dropped exit (the caller records them); only the Sentry error-level send is
/// withheld, and only until a second unconfirmed exit proves the first was not a
/// session end.
pub fn deferred_session_end_outcome(
    attribution: WindowsTerminatorAttribution,
    verdict: WindowsTeardownVerdict,
    latch: SessionEndLatchReading,
    unconfirmed_run_count: u32,
) -> DeferredSessionEndOutcome {
    if deferred_session_end_confirmed(attribution, verdict, latch) {
        return DeferredSessionEndOutcome::Drop;
    }
    if unconfirmed_session_terminate_escalates(unconfirmed_run_count) {
        DeferredSessionEndOutcome::Capture
    } else {
        DeferredSessionEndOutcome::Drop
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
///   - plan-limit refusals (`plan_limit::is_plan_limit_refusal_message`): a 402
///     `plan_limit_reached` / `PLAN_LIMIT_EXCEEDED` from hq-pro's hard stop is
///     the product telling a Starter company it is over a limit. The user fixes
///     it by upgrading or trimming, so it is shown, never reported to Sentry
///     (hard-stop-readiness US-018). Runners before hq-cloud US-012 surface the
///     refusal as an error event; this keeps those out of the alert path too.
///
/// Everything else (EISDIR, other 403/404 auth, 5xx-after-retries,
/// `UnknownError`, anything unrecognised) is treated as a real defect and keeps
/// alerting — fail safe toward surfacing, not swallowing.
pub fn is_alertable_error(err: &SyncErrorEvent) -> bool {
    !(is_entity_not_yet_provisioned(err)
        || is_transient_network_error(&err.message)
        || is_expected_acl_scope_skip(&err.message)
        || crate::plan_limit::is_plan_limit_refusal_message(&err.message))
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

/// The POSIX terminal-status shapes an app-owned SIGTERM/SIGKILL cancellation
/// can actually surface as. This set is the third suppression gate's POSIX
/// vocabulary and has exactly one home so it cannot drift between callers.
///
/// Trigger condition: consulted ONLY inside
/// [`classify_runner_exit_disposition_with_cancellation`] AFTER the
/// alertable-error short-circuit and only when a cause is present and the
/// termination was observed to take effect. Widening it can therefore only
/// convert an ALREADY-attributed, already-effective cancellation from `Alert`
/// to `CancelledByApp` — never a bare runner fault.
///
/// Three shapes are accepted, each a provable encoding of OUR OWN SIGTERM or
/// SIGKILL:
///   - `(None, SIGTERM|SIGKILL)` — the direct child died by the signal we
///     sent it;
///   - `(Some(1), None)` — an intermediary the app spawns instead of the runner
///     directly (`npx`, a version-manager shim, an interpreter) trapped our
///     signal and collapsed it into a generic failure code. This is the shape
///     HQ-DESKTOP-5Z reported on macOS, and the exact shape the Windows arm
///     already accepts (`TerminateJobObject(job, 1)`);
///   - `(Some(143), None)` / `(Some(137), None)` — the POSIX shell convention
///     `128 + signal` for a child killed by those same two signals, named
///     through [`SIGTERM_SIGNAL`]/[`SIGKILL_SIGNAL`] rather than as bare
///     literals.
///
/// Every OTHER non-zero exit code stays outside the set, so an arbitrary runner
/// crash that exits e.g. 2 keeps alerting even alongside a cancellation record.
pub fn posix_exit_matches_app_termination(code: Option<i32>, signal: Option<i32>) -> bool {
    match (code, signal) {
        (None, Some(SIGTERM_SIGNAL)) | (None, Some(SIGKILL_SIGNAL)) => true,
        (Some(code), None) => {
            code == 1 || code == 128 + SIGTERM_SIGNAL || code == 128 + SIGKILL_SIGNAL
        }
        _ => false,
    }
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
        TerminationHost::Posix => posix_exit_matches_app_termination(code, signal),
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
    should_alert_on_nonzero_exit(
        code,
        signal,
        saw_error,
        saw_alertable_error,
        saw_node_too_old,
    ) && !runner_exit_is_disk_exhaustion(code, signal, saw_genuine_crash, error_rollup)
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
#[path = "sync_outcome_tests.rs"]
mod tests;
