//! Process-wide provisioning retry guard (US-039).
//!
//! Wraps `run_cli_provision` for the two automatic callers —
//! `provision::provision_missing_companies` and
//! `provision_reconcile::reconcile_server_activated_companies` — with the
//! per-launch ledger from `hq_desktop_core::provision_retry`:
//!
//! * no `hq cloud provision company` spawn while no Cognito token is stored;
//! * exit 1 (vault auth/network) backs off and is retried on later passes,
//!   at most `MAX_ATTEMPTS_PER_LAUNCH` times per launch;
//! * when sign-in completes (`oauth_exchange_code`) every pending slug is
//!   retried right away by kicking a sync, and a retryable failure schedules
//!   its own delayed sync so the retry does not wait for the user.
//!
//! Manual Connect (`workspaces::connect_workspace_to_cloud`) bypasses the
//! ledger on purpose: the user asked, so the attempt always runs; its success
//! clears the slug's ledger entry.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use hq_desktop_core::provision_retry::{run_guarded, GuardedOutcome, ProvisionRetryLedger};
use hq_desktop_core::run_cli_provision::{
    run_cli_provision, CliProvisionError, CliProvisionResult,
};

use crate::util::logfile::log;

const LOG_TAG: &str = "provision-retry";

static LEDGER: OnceLock<Mutex<ProvisionRetryLedger>> = OnceLock::new();
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
/// One delayed retry sync in flight at a time; a second failure while one is
/// scheduled rides the already-scheduled pass.
static RETRY_SYNC_SCHEDULED: AtomicBool = AtomicBool::new(false);

fn ledger() -> &'static Mutex<ProvisionRetryLedger> {
    LEDGER.get_or_init(|| Mutex::new(ProvisionRetryLedger::new()))
}

/// Register the app handle once at setup so a retry can start a sync without
/// a command context. Idempotent.
pub fn install_app_handle(app: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app);
}

/// "Auth present" for the guard: a non-empty stored Cognito token. Fails
/// closed — an unreadable token file means no spawn this pass.
async fn has_stored_auth() -> bool {
    match crate::commands::cognito::has_non_empty_stored_token().await {
        Ok(present) => present,
        Err(e) => {
            log(
                LOG_TAG,
                &format!("auth presence check failed (treating as absent): {e}"),
            );
            false
        }
    }
}

/// `run_cli_provision` behind the per-launch ledger. Same signature as the
/// raw call so the `provisioner` seams in `provision.rs` /
/// `provision_reconcile.rs` swap in without changes.
pub async fn guarded_run_cli_provision(
    slug: &str,
    display_name: Option<&str>,
    hq_root: &Path,
) -> Result<CliProvisionResult, CliProvisionError> {
    let has_auth = has_stored_auth().await;
    let (result, outcome) = run_guarded(ledger(), slug, has_auth, Instant::now(), || {
        run_cli_provision(slug, display_name, hq_root)
    })
    .await;

    match &outcome {
        GuardedOutcome::Skipped(gate) => {
            let reason = gate.reason().unwrap_or_default();
            log(LOG_TAG, &format!("'{slug}': not spawned — {reason}"));
        }
        GuardedOutcome::Succeeded => {}
        GuardedOutcome::FailedRetryable { next_retry } => match next_retry {
            Some(wait) => {
                log(
                    LOG_TAG,
                    &format!(
                        "'{slug}': attempt failed (retryable); next automatic attempt in {}s",
                        wait.as_secs()
                    ),
                );
                schedule_retry_sync(*wait);
            }
            None => log(
                LOG_TAG,
                &format!(
                    "'{slug}': attempt failed (retryable); retry cap reached for this launch — use Connect on the company page"
                ),
            ),
        },
        GuardedOutcome::FailedTerminal => log(
            LOG_TAG,
            &format!("'{slug}': attempt failed (not retried automatically this launch)"),
        ),
    }
    result
}

/// Manual Connect succeeded: nothing left to retry for this slug.
pub fn note_manual_provision_success(slug: &str) {
    ledger()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .record_success(slug);
}

/// Sign-in completed. Clears every backoff and, when some company is still
/// waiting on a provisioning attempt, starts a sync so the reconcile pass
/// retries now rather than on the next manual sync.
pub fn on_auth_available(app: &tauri::AppHandle) {
    let pending = ledger()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .auth_available();
    if pending.is_empty() {
        return;
    }
    log(
        LOG_TAG,
        &format!("auth available; retrying provisioning for {pending:?}"),
    );
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_retry_sync(app, "post-sign-in").await;
    });
}

/// Slugs the ledger still owes an attempt (deferred or backing off).
pub fn pending_slugs() -> Vec<String> {
    ledger()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .pending_slugs()
}

fn schedule_retry_sync(wait: Duration) {
    let Some(app) = APP_HANDLE.get().cloned() else {
        log(
            LOG_TAG,
            "no app handle registered; retry waits for the next sync pass",
        );
        return;
    };
    if RETRY_SYNC_SCHEDULED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(wait).await;
        RETRY_SYNC_SCHEDULED.store(false, Ordering::Release);
        if pending_slugs().is_empty() {
            return;
        }
        run_retry_sync(app, "backoff").await;
    });
}

async fn run_retry_sync(app: tauri::AppHandle, trigger: &str) {
    match crate::commands::sync::start_sync(app, None).await {
        Ok(_) => log(LOG_TAG, &format!("{trigger}: retry sync started")),
        // "already running" / Cloud Off / no auth are all handled states —
        // the in-flight or next pass consults the same ledger.
        Err(e) => log(LOG_TAG, &format!("{trigger}: retry sync not started: {e}")),
    }
}
