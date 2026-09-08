//! Per-launch retry ledger for `hq cloud provision company` (US-039).
//!
//! Evidence (feedback_8efb8f09): the app spawned `hq cloud provision company
//! arbium` before the user had signed in, the CLI exited 1 ("vault
//! auth/network/API error — no entity provisioned"), and nothing ever retried
//! — the company stayed unconnected for the rest of the session.
//!
//! This module is the pure policy behind the fix:
//!
//! * an attempt is **deferred** (not counted) while auth is absent;
//! * a retryable failure (exit 1) schedules a backoff and counts one attempt;
//! * when auth arrives every backoff is cleared so the very next reconcile
//!   pass retries immediately;
//! * at most [`MAX_ATTEMPTS_PER_LAUNCH`] attempts run per app launch.
//!
//! The ledger is in-memory on purpose: "per launch" is the retry budget, and
//! a relaunch resets it. Time is injected (`Instant`) so tests are exact.

use std::collections::BTreeMap;
use std::future::Future;
use std::time::{Duration, Instant};

use crate::run_cli_provision::{CliProvisionError, CliProvisionResult};

/// Hard cap on automatic provisioning attempts for one slug per app launch.
pub const MAX_ATTEMPTS_PER_LAUNCH: u32 = 3;

/// Wait before the second and third attempts. Index = attempts already made
/// minus one. After the last attempt fails the slug is exhausted.
pub const BACKOFF_SCHEDULE: [Duration; 2] = [Duration::from_secs(30), Duration::from_secs(120)];

/// Why (or whether) a provisioning attempt may run right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProvisionGate {
    /// Run the attempt. `attempt` is 1-based.
    Proceed { attempt: u32 },
    /// No stored auth — the attempt was not spent. The slug is remembered so
    /// [`ProvisionRetryLedger::auth_available`] reports it as pending.
    DeferredNoAuth,
    /// A retryable failure happened recently; wait at least this long.
    Backoff { retry_after: Duration },
    /// The per-launch budget is spent (or the last failure was terminal for
    /// this launch). Only a manual Connect can run it again.
    Exhausted { attempts: u32 },
}

impl ProvisionGate {
    /// Human-readable reason for log lines and the `CliProvisionError::Deferred`
    /// message. `Proceed` has no reason.
    pub fn reason(&self) -> Option<String> {
        match self {
            Self::Proceed { .. } => None,
            Self::DeferredNoAuth => Some("waiting for sign-in".to_string()),
            Self::Backoff { retry_after } => Some(format!(
                "retry backoff, next attempt in {}s",
                retry_after.as_secs()
            )),
            Self::Exhausted { attempts } => Some(format!(
                "retry cap reached ({attempts}/{MAX_ATTEMPTS_PER_LAUNCH} attempts this launch)"
            )),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct SlugEntry {
    attempts: u32,
    not_before: Option<Instant>,
    deferred_for_auth: bool,
    /// Set by a failure that automatic retries cannot fix this launch
    /// (validation, missing CLI, broken local Node). Manual Connect bypasses
    /// the ledger, so the user can still act.
    terminal: bool,
}

impl SlugEntry {
    fn is_pending(&self) -> bool {
        if self.terminal {
            return false;
        }
        self.deferred_for_auth || (self.attempts > 0 && self.attempts < MAX_ATTEMPTS_PER_LAUNCH)
    }
}

/// In-memory retry state for every slug this launch has tried to provision.
#[derive(Debug, Default)]
pub struct ProvisionRetryLedger {
    entries: BTreeMap<String, SlugEntry>,
}

impl ProvisionRetryLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decide whether an attempt for `slug` may run at `now`.
    ///
    /// Never spends an attempt: the attempt is counted by
    /// [`record_retryable_failure`](Self::record_retryable_failure) /
    /// [`record_terminal_failure`](Self::record_terminal_failure) /
    /// [`record_success`](Self::record_success) after the run.
    pub fn gate(&mut self, slug: &str, has_auth: bool, now: Instant) -> ProvisionGate {
        let entry = self.entries.entry(slug.to_string()).or_default();
        if !has_auth {
            entry.deferred_for_auth = true;
            return ProvisionGate::DeferredNoAuth;
        }
        if entry.terminal || entry.attempts >= MAX_ATTEMPTS_PER_LAUNCH {
            return ProvisionGate::Exhausted {
                attempts: entry.attempts,
            };
        }
        if let Some(not_before) = entry.not_before {
            if not_before > now {
                return ProvisionGate::Backoff {
                    retry_after: not_before - now,
                };
            }
        }
        entry.deferred_for_auth = false;
        ProvisionGate::Proceed {
            attempt: entry.attempts + 1,
        }
    }

    /// Exit 1 (vault auth/network) or an unclassified failure: count one
    /// attempt and arm the next backoff. Returns the wait before the next
    /// automatic attempt, or `None` when the budget is now exhausted.
    pub fn record_retryable_failure(&mut self, slug: &str, now: Instant) -> Option<Duration> {
        let entry = self.entries.entry(slug.to_string()).or_default();
        entry.attempts += 1;
        entry.deferred_for_auth = false;
        if entry.attempts >= MAX_ATTEMPTS_PER_LAUNCH {
            entry.not_before = None;
            return None;
        }
        let wait = BACKOFF_SCHEDULE[(entry.attempts as usize - 1).min(BACKOFF_SCHEDULE.len() - 1)];
        entry.not_before = Some(now + wait);
        Some(wait)
    }

    /// Validation / spawn / local-env failure: automatic retries would only
    /// repeat it. Freeze the slug for this launch.
    pub fn record_terminal_failure(&mut self, slug: &str) {
        let entry = self.entries.entry(slug.to_string()).or_default();
        entry.attempts += 1;
        entry.deferred_for_auth = false;
        entry.terminal = true;
        entry.not_before = None;
    }

    /// The company is provisioned; forget it.
    pub fn record_success(&mut self, slug: &str) {
        self.entries.remove(slug);
    }

    /// Auth just became available. Every deferred slug and every slug sitting
    /// in backoff becomes eligible immediately, so the next reconcile pass
    /// retries without waiting. Returns the slugs that still need a pass.
    pub fn auth_available(&mut self) -> Vec<String> {
        for entry in self.entries.values_mut() {
            if !entry.terminal {
                entry.not_before = None;
            }
        }
        self.pending_slugs()
    }

    /// Slugs that were deferred for auth or failed retryably and still have
    /// budget left.
    pub fn pending_slugs(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(_, entry)| entry.is_pending())
            .map(|(slug, _)| slug.clone())
            .collect()
    }

    pub fn is_pending(&self, slug: &str) -> bool {
        self.entries.get(slug).is_some_and(SlugEntry::is_pending)
    }

    /// Attempts spent on `slug` this launch (0 when never tried).
    pub fn attempts(&self, slug: &str) -> u32 {
        self.entries.get(slug).map(|e| e.attempts).unwrap_or(0)
    }
}

/// What the guarded run did with the ledger after the provisioner returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardedOutcome {
    /// The attempt did not run; the error is `CliProvisionError::Deferred`.
    Skipped(ProvisionGate),
    /// Ran and succeeded (or provisioned with a sync-only failure).
    Succeeded,
    /// Ran and failed retryably; `next_retry` is the backoff, `None` when the
    /// budget is exhausted.
    FailedRetryable { next_retry: Option<Duration> },
    /// Ran and failed in a way automatic retries cannot fix this launch.
    FailedTerminal,
}

/// Classify a provisioner error for the ledger.
pub fn failure_is_retryable(err: &CliProvisionError) -> bool {
    matches!(
        err,
        CliProvisionError::Network(_) | CliProvisionError::Other(_)
    )
}

/// Run `provision` for `slug` behind the ledger.
///
/// * Absent auth, active backoff, or a spent budget short-circuits with
///   [`CliProvisionError::Deferred`] and never spawns the CLI.
/// * `CliProvisionError::Sync` counts as provisioned: the entity, manifest and
///   config were written; only the upload failed, and normal sync retries it.
pub async fn run_guarded<F, Fut>(
    ledger: &std::sync::Mutex<ProvisionRetryLedger>,
    slug: &str,
    has_auth: bool,
    now: Instant,
    provision: F,
) -> (
    Result<CliProvisionResult, CliProvisionError>,
    GuardedOutcome,
)
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<CliProvisionResult, CliProvisionError>>,
{
    let gate = {
        let mut guard = ledger
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.gate(slug, has_auth, now)
    };
    if let Some(reason) = gate.reason() {
        return (
            Err(CliProvisionError::Deferred(format!(
                "slug={slug}: {reason}"
            ))),
            GuardedOutcome::Skipped(gate),
        );
    }

    let result = provision().await;
    let outcome = {
        let mut guard = ledger
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &result {
            Ok(_) | Err(CliProvisionError::Sync { .. }) => {
                guard.record_success(slug);
                GuardedOutcome::Succeeded
            }
            Err(err) if failure_is_retryable(err) => GuardedOutcome::FailedRetryable {
                next_retry: guard.record_retryable_failure(slug, Instant::now()),
            },
            Err(_) => {
                guard.record_terminal_failure(slug);
                GuardedOutcome::FailedTerminal
            }
        }
    };
    (result, outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_cli_provision::CliInitialSync;
    use std::sync::{Arc, Mutex};

    fn ok_result(slug: &str) -> CliProvisionResult {
        CliProvisionResult {
            ok: true,
            company_slug: slug.to_string(),
            cloud_uid: "cmp_1".into(),
            bucket_name: "hq-vault-cmp-1".into(),
            vault_api_url: "https://vault.example".into(),
            kms_key_id: None,
            created_entity: true,
            manifest_patched: true,
            config_written: true,
            initial_sync: CliInitialSync {
                ok: None,
                files_uploaded: None,
                bytes_uploaded: None,
                error: None,
                skipped: Some(true),
            },
        }
    }

    fn exit1() -> CliProvisionError {
        CliProvisionError::Network("exit 1 (vault)".into())
    }

    #[test]
    fn attempt_before_auth_is_deferred_and_not_counted() {
        let mut ledger = ProvisionRetryLedger::new();
        let t0 = Instant::now();
        assert_eq!(
            ledger.gate("arbium", false, t0),
            ProvisionGate::DeferredNoAuth
        );
        assert_eq!(
            ledger.gate("arbium", false, t0),
            ProvisionGate::DeferredNoAuth
        );
        assert_eq!(ledger.attempts("arbium"), 0);
        assert!(ledger.is_pending("arbium"));
        assert_eq!(ledger.pending_slugs(), vec!["arbium".to_string()]);
    }

    #[test]
    fn deferred_attempt_proceeds_once_auth_arrives() {
        let mut ledger = ProvisionRetryLedger::new();
        let t0 = Instant::now();
        assert_eq!(
            ledger.gate("arbium", false, t0),
            ProvisionGate::DeferredNoAuth
        );
        assert_eq!(ledger.auth_available(), vec!["arbium".to_string()]);
        assert_eq!(
            ledger.gate("arbium", true, t0),
            ProvisionGate::Proceed { attempt: 1 }
        );
        assert!(
            !ledger.is_pending("arbium"),
            "a running attempt is not pending"
        );
    }

    #[test]
    fn failed_attempt_backs_off_then_retries() {
        let mut ledger = ProvisionRetryLedger::new();
        let t0 = Instant::now();
        assert_eq!(
            ledger.gate("arbium", true, t0),
            ProvisionGate::Proceed { attempt: 1 }
        );
        assert_eq!(
            ledger.record_retryable_failure("arbium", t0),
            Some(BACKOFF_SCHEDULE[0])
        );
        // Same reconcile pass, a second later: still backing off.
        assert!(matches!(
            ledger.gate("arbium", true, t0 + Duration::from_secs(1)),
            ProvisionGate::Backoff { .. }
        ));
        // Once the schedule elapses the next pass proceeds as attempt 2.
        assert_eq!(
            ledger.gate("arbium", true, t0 + BACKOFF_SCHEDULE[0]),
            ProvisionGate::Proceed { attempt: 2 }
        );
        assert_eq!(
            ledger.record_retryable_failure("arbium", t0 + BACKOFF_SCHEDULE[0]),
            Some(BACKOFF_SCHEDULE[1])
        );
        assert!(BACKOFF_SCHEDULE[1] > BACKOFF_SCHEDULE[0], "backoff grows");
    }

    #[test]
    fn failed_attempt_is_retried_immediately_after_auth_arrives() {
        let mut ledger = ProvisionRetryLedger::new();
        let t0 = Instant::now();
        ledger.gate("arbium", true, t0);
        ledger.record_retryable_failure("arbium", t0);
        assert!(matches!(
            ledger.gate("arbium", true, t0),
            ProvisionGate::Backoff { .. }
        ));
        // Sign-in (or a token refresh) clears the backoff.
        assert_eq!(ledger.auth_available(), vec!["arbium".to_string()]);
        assert_eq!(
            ledger.gate("arbium", true, t0),
            ProvisionGate::Proceed { attempt: 2 }
        );
    }

    #[test]
    fn retry_cap_is_honoured_per_launch() {
        let mut ledger = ProvisionRetryLedger::new();
        let mut now = Instant::now();
        for attempt in 1..=MAX_ATTEMPTS_PER_LAUNCH {
            assert_eq!(
                ledger.gate("arbium", true, now),
                ProvisionGate::Proceed { attempt }
            );
            let wait = ledger.record_retryable_failure("arbium", now);
            if attempt < MAX_ATTEMPTS_PER_LAUNCH {
                now += wait.expect("budget left");
            } else {
                assert_eq!(wait, None, "last failure exhausts the budget");
            }
        }
        assert_eq!(
            ledger.gate("arbium", true, now + Duration::from_secs(3600)),
            ProvisionGate::Exhausted {
                attempts: MAX_ATTEMPTS_PER_LAUNCH
            }
        );
        // Auth arriving again does not reopen the budget.
        assert!(ledger.auth_available().is_empty());
        assert!(matches!(
            ledger.gate("arbium", true, now),
            ProvisionGate::Exhausted { .. }
        ));
        // A fresh ledger (new launch) starts over.
        assert_eq!(
            ProvisionRetryLedger::new().gate("arbium", true, now),
            ProvisionGate::Proceed { attempt: 1 }
        );
    }

    #[test]
    fn terminal_failure_is_not_retried_automatically() {
        let mut ledger = ProvisionRetryLedger::new();
        let t0 = Instant::now();
        ledger.gate("arbium", true, t0);
        ledger.record_terminal_failure("arbium");
        assert!(matches!(
            ledger.gate("arbium", true, t0 + Duration::from_secs(3600)),
            ProvisionGate::Exhausted { .. }
        ));
        assert!(!ledger.is_pending("arbium"));
        assert!(ledger.auth_available().is_empty());
    }

    #[test]
    fn success_clears_the_slug() {
        let mut ledger = ProvisionRetryLedger::new();
        let t0 = Instant::now();
        ledger.gate("arbium", true, t0);
        ledger.record_retryable_failure("arbium", t0);
        ledger.record_success("arbium");
        assert_eq!(ledger.attempts("arbium"), 0);
        assert!(ledger.pending_slugs().is_empty());
        assert_eq!(
            ledger.gate("arbium", true, t0),
            ProvisionGate::Proceed { attempt: 1 }
        );
    }

    #[test]
    fn slugs_are_tracked_independently() {
        let mut ledger = ProvisionRetryLedger::new();
        let t0 = Instant::now();
        ledger.gate("arbium", true, t0);
        ledger.record_retryable_failure("arbium", t0);
        assert_eq!(
            ledger.gate("acme", true, t0),
            ProvisionGate::Proceed { attempt: 1 }
        );
    }

    #[tokio::test]
    async fn run_guarded_never_spawns_without_auth() {
        let ledger = Mutex::new(ProvisionRetryLedger::new());
        let spawned = Arc::new(Mutex::new(0u32));
        let counter = Arc::clone(&spawned);
        let (result, outcome) =
            run_guarded(&ledger, "arbium", false, Instant::now(), || async move {
                *counter.lock().unwrap() += 1;
                Ok(ok_result("arbium"))
            })
            .await;
        assert_eq!(*spawned.lock().unwrap(), 0);
        assert!(matches!(result, Err(CliProvisionError::Deferred(_))));
        assert_eq!(
            outcome,
            GuardedOutcome::Skipped(ProvisionGate::DeferredNoAuth)
        );
        assert!(ledger.lock().unwrap().is_pending("arbium"));
    }

    #[tokio::test]
    async fn run_guarded_counts_exit_1_and_retries_after_auth() {
        let ledger = Mutex::new(ProvisionRetryLedger::new());
        let t0 = Instant::now();

        let (result, outcome) =
            run_guarded(&ledger, "arbium", true, t0, || async { Err(exit1()) }).await;
        assert!(matches!(result, Err(CliProvisionError::Network(_))));
        assert_eq!(
            outcome,
            GuardedOutcome::FailedRetryable {
                next_retry: Some(BACKOFF_SCHEDULE[0])
            }
        );

        // Next pass inside the backoff window: skipped, CLI not spawned.
        let (result, outcome) = run_guarded(&ledger, "arbium", true, t0, || async {
            panic!("must not spawn during backoff")
        })
        .await;
        assert!(matches!(result, Err(CliProvisionError::Deferred(_))));
        assert!(matches!(
            outcome,
            GuardedOutcome::Skipped(ProvisionGate::Backoff { .. })
        ));

        // Auth arrives → the next pass retries immediately and succeeds.
        assert_eq!(
            ledger.lock().unwrap().auth_available(),
            vec!["arbium".to_string()]
        );
        let (result, outcome) = run_guarded(&ledger, "arbium", true, t0, || async {
            Ok(ok_result("arbium"))
        })
        .await;
        assert!(result.is_ok());
        assert_eq!(outcome, GuardedOutcome::Succeeded);
        assert!(ledger.lock().unwrap().pending_slugs().is_empty());
    }

    #[tokio::test]
    async fn run_guarded_stops_after_the_cap() {
        let ledger = Mutex::new(ProvisionRetryLedger::new());
        let spawned = Arc::new(Mutex::new(0u32));
        for _ in 0..MAX_ATTEMPTS_PER_LAUNCH + 2 {
            // Clearing the backoff each time isolates the cap from the schedule.
            ledger.lock().unwrap().auth_available();
            let counter = Arc::clone(&spawned);
            let _ = run_guarded(&ledger, "arbium", true, Instant::now(), || async move {
                *counter.lock().unwrap() += 1;
                Err(exit1())
            })
            .await;
        }
        assert_eq!(*spawned.lock().unwrap(), MAX_ATTEMPTS_PER_LAUNCH);
        let (result, outcome) = run_guarded(&ledger, "arbium", true, Instant::now(), || async {
            panic!("budget is spent")
        })
        .await;
        assert!(matches!(result, Err(CliProvisionError::Deferred(_))));
        assert!(matches!(
            outcome,
            GuardedOutcome::Skipped(ProvisionGate::Exhausted { .. })
        ));
    }

    #[tokio::test]
    async fn run_guarded_treats_validation_as_terminal_and_sync_as_success() {
        let ledger = Mutex::new(ProvisionRetryLedger::new());
        let (_, outcome) = run_guarded(&ledger, "bad", true, Instant::now(), || async {
            Err(CliProvisionError::Validation("bad slug".into()))
        })
        .await;
        assert_eq!(outcome, GuardedOutcome::FailedTerminal);
        assert!(!ledger.lock().unwrap().is_pending("bad"));

        let (_, outcome) = run_guarded(&ledger, "acme", true, Instant::now(), || async {
            Err(CliProvisionError::Sync {
                message: "upload failed".into(),
                partial: Some(ok_result("acme")),
            })
        })
        .await;
        assert_eq!(outcome, GuardedOutcome::Succeeded);
        assert_eq!(ledger.lock().unwrap().attempts("acme"), 0);
    }

    #[test]
    fn deferred_error_display_carries_the_reason() {
        let e = CliProvisionError::Deferred("slug=arbium: waiting for sign-in".into());
        assert!(e.is_deferred());
        assert!(e.to_string().contains("waiting for sign-in"));
    }
}
