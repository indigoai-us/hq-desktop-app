use crate::events::{SyncCompleteEvent, SyncErrorEvent, SyncEvent};

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
        if is_alertable_error(err) {
            self.saw_alertable_error = true;
        }
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

/// POSIX SIGTERM. When the runner exits killed by this signal it was OUR
/// cancellation: `cancel_process_impl` sends SIGTERM (escalating to SIGKILL
/// only if the runner ignores it) on every expected cancel — the Stop button,
/// the 1-hour timeout watchdog, app quit, or a newer sync superseding this one.
/// An expected cancellation must never escalate to a Sentry alert (HQ-SYNC-WEB-H:
/// 23 "killed by SIGTERM (cancelled)" events). See `should_alert_on_nonzero_exit`.
pub const SIGTERM_SIGNAL: i32 = 15;

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
        (Some(code), None) => format!("exit:{code}"),
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

/// Pure policy: should a *non-zero* runner exit raise a Sentry alert?
///
/// Extracted from the `ProcessEvent::Exit` handler so the decision is
/// unit-testable without a live `AppHandle`. Returns `false` (suppress) for the
/// non-actionable exits this issue was drowning in, `true` (alert) otherwise:
///
///   - exit 17 (`OPERATION_LOCKED`): another sync holds the lock — a normal
///     concurrent-sync race, never a failure.
///   - a run whose errors were all benign (`saw_error && !saw_alertable_error`):
///     the non-zero exit is fully explained by not-yet-provisioned 404s,
///     transient network blips, and/or expected per-file ACL-scope skips.
///   - a Node-too-old startup crash (`saw_node_too_old`): the runner could not
///     start under the user's Node version, so this is an environment fault
///     surfaced to the UI rather than an alertable product defect.
///
/// An *unexplained* non-zero exit — no error event seen at all, e.g. the runner
/// panicked or was OOM-killed before emitting protocol — still alerts,
/// preserving the original "bailed before emitting a useful stream" signal.
///
/// A SIGTERM kill is the one signal that is NEVER a defect: it is our own
/// `cancel_process_impl` ending the run (Stop / timeout / quit / supersede), so
/// it is suppressed regardless of any in-flight company errors. Other signals
/// stay loud — SIGSEGV/SIGBUS/SIGABRT are crashes, and SIGKILL is OOM or a
/// force-quit worth seeing; only the cooperative SIGTERM is "expected".
pub fn should_alert_on_nonzero_exit(
    code: Option<i32>,
    signal: Option<i32>,
    saw_error: bool,
    saw_alertable_error: bool,
    saw_node_too_old: bool,
) -> bool {
    if signal == Some(SIGTERM_SIGNAL) {
        return false;
    }
    if code == Some(RUNNER_OPERATION_LOCKED_EXIT) {
        return false;
    }
    if saw_node_too_old {
        return false;
    }
    if saw_error && !saw_alertable_error {
        return false;
    }
    true
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
    fn termination_fingerprint_separates_exit_codes_from_signals() {
        assert_eq!(termination_fingerprint_token(Some(2), None), "exit:2");
        assert_eq!(termination_fingerprint_token(None, Some(2)), "signal:2");
        assert_eq!(termination_fingerprint_token(Some(126), None), "exit:126");
        assert_ne!(
            termination_fingerprint_token(Some(2), None),
            termination_fingerprint_token(Some(126), None)
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
}
