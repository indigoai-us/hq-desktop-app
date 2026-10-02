//! Durable referral delivery for desktop sign-in.
//!
//! The queue intentionally stores only the browser-link nonce and delivery
//! metadata. It never stores bearer tokens, refresh tokens, ID tokens, raw
//! authorize URLs, or signed referral proofs.
//!
//! Compatibility limits: old desktop clients do not speak the ACK protocol and
//! must be updated; a different browser profile may not have the website cookie;
//! and the desktop does not use device fingerprinting to infer a referral.

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const REFERRAL_PROTOCOL_VERSION: &str = "1";
pub const QUEUE_VERSION: u8 = 1;
pub const QUEUE_FILE_NAME: &str = "desktop-referral-receipts.json";
const LOCK_FILE_NAME: &str = "desktop-referral-receipts.lock";
const LOCK_WAIT: Duration = Duration::from_millis(250);
const LOCK_POLL: Duration = Duration::from_millis(10);
const IO_DEADLINE: Duration = Duration::from_secs(2);
const PENDING_EXPIRY_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
const INITIAL_RETRY_DELAY_MS: i64 = 1_000;
const MAX_RETRY_DELAY_MS: i64 = 60 * 60 * 1_000;
const MAX_FAST_ATTEMPTS: u8 = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReferralReceipt {
    pub nonce: String,
    pub created_at_ms: i64,
    #[serde(default)]
    pub authorized_subject: Option<String>,
    #[serde(default)]
    pub attempts: u8,
    #[serde(default)]
    pub next_attempt_at_ms: i64,
}

impl ReferralReceipt {
    pub fn new(nonce: impl Into<String>, created_at_ms: i64) -> Self {
        Self {
            nonce: nonce.into(),
            created_at_ms,
            authorized_subject: None,
            attempts: 0,
            next_attempt_at_ms: 0,
        }
    }

    pub fn is_expired_at(&self, now_ms: i64) -> bool {
        now_ms.saturating_sub(self.created_at_ms) >= PENDING_EXPIRY_MS
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferralQueue {
    version: u8,
    receipts: Vec<ReferralReceipt>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReferralDelivery {
    Delivered(ReferralStatus),
    Retry,
    /// Durable receipt belongs to an account that is not the active session.
    /// It remains unchanged until an auth transition wakes the scheduler.
    Held,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReferralStatus {
    Bound,
    None,
    Expired,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferralAck {
    pub referral: ReferralAckReferral,
    #[serde(default)]
    pub anon_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferralAckReferral {
    pub status: ReferralStatus,
}

pub fn queue_path_from_home(home: &Path) -> PathBuf {
    home.join(".hq").join(QUEUE_FILE_NAME)
}

pub fn referral_link_body(link: &str, download_aid: Option<&str>) -> serde_json::Value {
    let mut body = crate::desktop_signin_link::signin_link_body(link, download_aid);
    body["referralProtocol"] = serde_json::json!(REFERRAL_PROTOCOL_VERSION);
    body
}

pub fn classify_referral_response(status: u16, body: &str) -> ReferralDelivery {
    match parse_referral_ack(status, body) {
        Some(ack) => ReferralDelivery::Delivered(ack.referral.status),
        None => ReferralDelivery::Retry,
    }
}

pub fn parse_referral_ack(status: u16, body: &str) -> Option<ReferralAck> {
    if status != 200 && status != 403 {
        return None;
    }
    let body: serde_json::Value = serde_json::from_str(body).ok()?;
    let referral: ReferralAckReferral =
        serde_json::from_value(body.get("referral")?.clone()).ok()?;
    if status == 403 && referral.status != ReferralStatus::Rejected {
        return None;
    }
    let anon_id = body
        .get("anonId")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 128);
    Some(ReferralAck {
        referral,
        anon_id: anon_id.map(str::to_string),
    })
}

pub fn may_deliver_for_subject(
    authorized_subject: Option<&str>,
    active_subject: Option<&str>,
) -> bool {
    matches!(
        (authorized_subject, active_subject),
        (Some(authorized), Some(active)) if authorized == active
    )
}

pub fn next_retry_at_ms(now_ms: i64, prior_attempts: u8) -> i64 {
    let delay = if prior_attempts >= MAX_FAST_ATTEMPTS {
        MAX_RETRY_DELAY_MS
    } else {
        INITIAL_RETRY_DELAY_MS
            .saturating_mul(1_i64.checked_shl(prior_attempts as u32).unwrap_or(i64::MAX))
            .min(MAX_RETRY_DELAY_MS)
    };
    now_ms.saturating_add(delay)
}

pub fn next_attempt_count(prior_attempts: u8) -> u8 {
    prior_attempts.saturating_add(1).min(MAX_FAST_ATTEMPTS)
}

pub fn read_queue(path: &Path) -> Result<Vec<ReferralReceipt>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let body = fs::read_to_string(path).map_err(|error| format!("read referral queue: {error}"))?;
    let queue: ReferralQueue =
        serde_json::from_str(&body).map_err(|error| format!("parse referral queue: {error}"))?;
    if queue.version != QUEUE_VERSION {
        return Err(format!(
            "unsupported referral queue version: {}",
            queue.version
        ));
    }
    Ok(queue.receipts)
}

fn write_queue(path: &Path, receipts: &[ReferralReceipt]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "referral queue has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("create referral queue dir: {error}"))?;
    let queue = ReferralQueue {
        version: QUEUE_VERSION,
        receipts: receipts.to_vec(),
    };
    let body =
        serde_json::to_vec(&queue).map_err(|error| format!("serialize referral queue: {error}"))?;
    let temporary = parent.join(format!(".{}.tmp-{}", QUEUE_FILE_NAME, uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("create referral queue temp file: {error}"))?;
    file.write_all(&body)
        .map_err(|error| format!("write referral queue temp file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("sync referral queue temp file: {error}"))?;
    drop(file);
    replace_file(&temporary, path)?;
    sync_parent(parent);
    Ok(())
}

fn replace_file(temporary: &Path, target: &Path) -> Result<(), String> {
    // `std::fs::rename` is the replacement primitive on every supported
    // desktop platform. In particular, Rust implements Windows rename with
    // `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`, so deleting the live file
    // first would only introduce a crash window that the primitive avoids.
    fs::rename(temporary, target).map_err(|error| format!("commit referral queue: {error}"))
}

fn sync_parent(parent: &Path) {
    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_all();
    }
}

fn lock_file_for(path: &Path) -> Result<File, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "referral queue has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("create referral queue dir: {error}"))?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(parent.join(LOCK_FILE_NAME))
        .map_err(|error| format!("open referral queue lock: {error}"))
}

fn with_locked_queue<T>(
    path: &Path,
    f: impl FnOnce(Vec<ReferralReceipt>) -> Result<(Vec<ReferralReceipt>, T), String>,
) -> Result<T, String> {
    let lock = lock_file_for(path)?;
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match lock.try_lock_exclusive() {
            Ok(()) => break,
            Err(error)
                if error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(LOCK_POLL);
            }
            Err(error) => return Err(format!("lock referral queue: {error}")),
        }
    }
    let current = read_queue(path)?;
    let (next, result) = f(current)?;
    write_queue(path, &next)?;
    lock.unlock()
        .map_err(|error| format!("unlock referral queue: {error}"))?;
    Ok(result)
}

pub fn enqueue(path: &Path, receipt: ReferralReceipt) -> Result<(), String> {
    with_locked_queue(path, |mut receipts| {
        // Every new browser handoff is also a queue-maintenance edge. This
        // prevents abandoned, unbound attempts from accumulating when nobody
        // has an authenticated session capable of running the delivery drain.
        receipts.retain(|existing| !existing.is_expired_at(receipt.created_at_ms));
        if !receipts
            .iter()
            .any(|existing| existing.nonce == receipt.nonce)
        {
            receipts.push(receipt);
        }
        Ok((receipts, ()))
    })
}

pub fn authorize_nonce(path: &Path, nonce: &str, subject: &str) -> Result<bool, String> {
    with_locked_queue(path, |mut receipts| {
        let mut updated = false;
        for receipt in receipts.iter_mut().filter(|receipt| receipt.nonce == nonce) {
            match receipt.authorized_subject.as_deref() {
                None => {
                    receipt.authorized_subject = Some(subject.to_string());
                    updated = true;
                }
                Some(existing) if existing == subject => updated = true,
                Some(_) => {
                    return Err(
                        "referral nonce is already authorized for another account".to_string()
                    )
                }
            }
        }
        Ok((receipts, updated))
    })
}

pub fn due_receipts(path: &Path, now_ms: i64) -> Result<Vec<ReferralReceipt>, String> {
    Ok(read_queue(path)?
        .into_iter()
        .filter(|receipt| receipt.next_attempt_at_ms <= now_ms)
        .collect())
}

/// Earliest scheduled attempt belonging to the active account. Unbound rows
/// and rows bound to another account are deliberately ignored so the scheduler
/// can sleep without either adopting or spinning on them.
pub fn earliest_attempt_at_for_subject(path: &Path, subject: &str) -> Result<Option<i64>, String> {
    Ok(read_queue(path)?
        .into_iter()
        .filter(|receipt| receipt.authorized_subject.as_deref() == Some(subject))
        .map(|receipt| receipt.next_attempt_at_ms)
        .min())
}

pub fn remove_nonce(path: &Path, nonce: &str) -> Result<(), String> {
    with_locked_queue(path, |receipts| {
        Ok((
            receipts
                .into_iter()
                .filter(|receipt| receipt.nonce != nonce)
                .collect(),
            (),
        ))
    })
}

/// Remove a cancelled/superseded receipt only while it remains unbound.
///
/// Authorization can race best-effort teardown. Once a receipt has an
/// immutable subject it is proof awaiting delivery, so cancellation must not
/// be able to erase it. Server-ACK cleanup uses [`remove_nonce`] instead.
pub fn discard_unbound_nonce(path: &Path, nonce: &str) -> Result<bool, String> {
    with_locked_queue(path, |receipts| {
        let mut discarded = false;
        let retained = receipts
            .into_iter()
            .filter(|receipt| {
                let should_discard = receipt.nonce == nonce && receipt.authorized_subject.is_none();
                discarded |= should_discard;
                !should_discard
            })
            .collect();
        Ok((retained, discarded))
    })
}

pub fn retain_with_retry(path: &Path, nonce: &str, now_ms: i64) -> Result<(), String> {
    with_locked_queue(path, |mut receipts| {
        for receipt in receipts.iter_mut().filter(|receipt| receipt.nonce == nonce) {
            receipt.next_attempt_at_ms = next_retry_at_ms(now_ms, receipt.attempts);
            receipt.attempts = next_attempt_count(receipt.attempts);
        }
        Ok((receipts, ()))
    })
}

pub fn expire_old(path: &Path, now_ms: i64) -> Result<Vec<ReferralReceipt>, String> {
    with_locked_queue(path, |receipts| {
        let mut expired = Vec::new();
        let retained = receipts
            .into_iter()
            .filter(|receipt| {
                if receipt.is_expired_at(now_ms) {
                    expired.push(receipt.clone());
                    false
                } else {
                    true
                }
            })
            .collect();
        Ok((retained, expired))
    })
}

async fn run_mutation<T, F>(operation: F, label: &'static str) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    // A running blocking task cannot be cancelled by dropping its JoinHandle.
    // Mutations therefore have no outer timeout: callers receive the worker's
    // real completion acknowledgement and can never be told "failed" while a
    // write is still capable of committing later. The cross-process file-lock
    // acquisition inside the operation remains independently bounded.
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| format!("{label} task failed: {error}"))?
}

pub async fn enqueue_async(path: PathBuf, receipt: ReferralReceipt) -> Result<(), String> {
    run_mutation(
        move || enqueue(&path, receipt),
        "referral queue persistence",
    )
    .await
}

pub async fn authorize_nonce_async(
    path: PathBuf,
    nonce: String,
    subject: String,
) -> Result<bool, String> {
    run_mutation(
        move || authorize_nonce(&path, &nonce, &subject),
        "referral queue authorization",
    )
    .await
}

pub async fn due_receipts_async(
    path: PathBuf,
    now_ms: i64,
) -> Result<Vec<ReferralReceipt>, String> {
    tokio::time::timeout(
        IO_DEADLINE,
        tokio::task::spawn_blocking(move || due_receipts(&path, now_ms)),
    )
    .await
    .map_err(|_| "referral queue read timed out".to_string())?
    .map_err(|error| format!("referral queue read task failed: {error}"))?
}

pub async fn remove_nonce_async(path: PathBuf, nonce: String) -> Result<(), String> {
    run_mutation(move || remove_nonce(&path, &nonce), "referral queue update").await
}

pub async fn discard_unbound_nonce_async(path: PathBuf, nonce: String) -> Result<bool, String> {
    run_mutation(
        move || discard_unbound_nonce(&path, &nonce),
        "unbound referral queue cleanup",
    )
    .await
}

pub async fn retain_with_retry_async(
    path: PathBuf,
    nonce: String,
    now_ms: i64,
) -> Result<(), String> {
    run_mutation(
        move || retain_with_retry(&path, &nonce, now_ms),
        "referral queue retry update",
    )
    .await
}

pub async fn expire_old_async(path: PathBuf, now_ms: i64) -> Result<Vec<ReferralReceipt>, String> {
    run_mutation(move || expire_old(&path, now_ms), "referral queue expiry").await
}

pub async fn earliest_attempt_at_for_subject_async(
    path: PathBuf,
    subject: String,
) -> Result<Option<i64>, String> {
    tokio::time::timeout(
        IO_DEADLINE,
        tokio::task::spawn_blocking(move || earliest_attempt_at_for_subject(&path, &subject)),
    )
    .await
    .map_err(|_| "referral queue schedule read timed out".to_string())?
    .map_err(|error| format!("referral queue schedule read task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue_path(dir: &tempfile::TempDir) -> PathBuf {
        queue_path_from_home(dir.path())
    }

    #[test]
    fn desktop_referral_queue_roundtrips_through_a_real_temp_dir() {
        let home = tempfile::tempdir().expect("temp home");
        let path = queue_path(&home);
        enqueue(&path, ReferralReceipt::new("nonce-a", 100)).expect("enqueue");
        let reloaded = read_queue(&path).expect("read after restart");
        assert_eq!(reloaded, vec![ReferralReceipt::new("nonce-a", 100)]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn desktop_referral_mutations_run_on_the_blocking_pool_and_ack_real_failures() {
        let async_thread = std::thread::current().id();
        let worker_thread = run_mutation(
            || Ok(std::thread::current().id()),
            "referral queue test mutation",
        )
        .await
        .expect("blocking worker completes");
        assert_ne!(worker_thread, async_thread);

        let home = tempfile::tempdir().expect("temp home");
        fs::write(home.path().join(".hq"), "not a directory").expect("blocking parent");
        let path = queue_path(&home);
        let error = enqueue_async(path.clone(), ReferralReceipt::new("nonce-a", 100))
            .await
            .expect_err("persistence failure is acknowledged");
        assert!(error.contains("create referral queue dir"));
        assert!(!path.exists(), "a failed append cannot commit later");

        let unlocked_home = tempfile::tempdir().expect("second temp home");
        let unlocked_path = queue_path(&unlocked_home);
        let lock = lock_file_for(&unlocked_path).expect("queue lock file");
        lock.lock_exclusive().expect("hold queue lock");
        let started = Instant::now();
        let enqueue_task = tokio::spawn(enqueue_async(
            unlocked_path.clone(),
            ReferralReceipt::new("off-thread", 200),
        ));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "the real queue lock wait must not block the async executor"
        );
        lock.unlock().expect("release queue lock");
        enqueue_task
            .await
            .expect("enqueue task joins")
            .expect("enqueue completes after lock release");
        assert_eq!(
            read_queue(&unlocked_path).expect("read off-thread enqueue")[0].nonce,
            "off-thread"
        );
    }

    #[test]
    fn desktop_referral_unbound_entries_are_not_adopted_by_later_accounts() {
        let receipt = ReferralReceipt::new("nonce-a", 100);
        assert!(!may_deliver_for_subject(
            receipt.authorized_subject.as_deref(),
            Some("subject-a")
        ));
    }

    #[test]
    fn desktop_referral_authorization_is_immutable_across_accounts() {
        let home = tempfile::tempdir().expect("temp home");
        let path = queue_path(&home);
        enqueue(&path, ReferralReceipt::new("nonce-a", 100)).expect("enqueue");
        assert_eq!(authorize_nonce(&path, "nonce-a", "subject-a"), Ok(true));
        assert_eq!(
            authorize_nonce(&path, "nonce-a", "subject-a"),
            Ok(true),
            "same-account authorization is idempotent"
        );
        let error = authorize_nonce(&path, "nonce-a", "subject-b")
            .expect_err("another account cannot rebind a durable nonce");
        assert!(error.contains("another account"));
        assert_eq!(
            read_queue(&path).expect("read after rejected rebind")[0]
                .authorized_subject
                .as_deref(),
            Some("subject-a")
        );
    }

    #[test]
    fn desktop_referral_cancel_removal_survives_restart_without_adoption() {
        let home = tempfile::tempdir().expect("temp home");
        let path = queue_path(&home);
        enqueue(&path, ReferralReceipt::new("cancelled", 100)).expect("enqueue");
        assert!(discard_unbound_nonce(&path, "cancelled").expect("cancel cleanup"));

        assert!(read_queue(&path).expect("restart read").is_empty());
        assert_eq!(
            authorize_nonce(&path, "cancelled", "later-account"),
            Ok(false),
            "a later account cannot adopt a cancelled nonce"
        );
    }

    #[test]
    fn desktop_referral_unbound_cleanup_cannot_delete_authorized_proof() {
        let home = tempfile::tempdir().expect("temp home");
        let path = queue_path(&home);
        enqueue(&path, ReferralReceipt::new("superseded", 100)).expect("unbound enqueue");
        enqueue(&path, ReferralReceipt::new("authorized", 200)).expect("bound enqueue");
        authorize_nonce(&path, "authorized", "subject-a").expect("authorize receipt");

        assert!(discard_unbound_nonce(&path, "superseded").expect("discard superseded unbound row"));
        assert!(
            !discard_unbound_nonce(&path, "authorized").expect("authorized cleanup is a no-op"),
            "a cancellation race cannot delete an authorized receipt"
        );

        let retained = read_queue(&path).expect("read retained proof");
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].nonce, "authorized");
        assert_eq!(retained[0].authorized_subject.as_deref(), Some("subject-a"));
    }

    #[test]
    fn desktop_referral_restart_schedule_uses_only_the_active_accounts_deadline() {
        let home = tempfile::tempdir().expect("temp home");
        let path = queue_path(&home);
        let mut active = ReferralReceipt::new("active", 100);
        active.authorized_subject = Some("subject-a".to_string());
        active.next_attempt_at_ms = 50_000;
        let mut other = ReferralReceipt::new("other", 100);
        other.authorized_subject = Some("subject-b".to_string());
        other.next_attempt_at_ms = 0;
        let unbound = ReferralReceipt::new("unbound", 100);
        enqueue(&path, active).expect("active");
        enqueue(&path, other).expect("other");
        enqueue(&path, unbound).expect("unbound");

        assert_eq!(
            earliest_attempt_at_for_subject(&path, "subject-a").expect("restart schedule"),
            Some(50_000)
        );
        assert_eq!(
            earliest_attempt_at_for_subject(&path, "subject-c").expect("held schedule"),
            None,
            "another account's due receipt must not cause a scheduler spin"
        );
    }

    #[test]
    fn desktop_referral_enqueue_expires_abandoned_entries() {
        let home = tempfile::tempdir().expect("temp home");
        let path = queue_path(&home);
        enqueue(&path, ReferralReceipt::new("abandoned", 100)).expect("old enqueue");
        enqueue(
            &path,
            ReferralReceipt::new("fresh", 100 + PENDING_EXPIRY_MS),
        )
        .expect("new enqueue");
        let receipts = read_queue(&path).expect("maintained queue");
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].nonce, "fresh");
    }

    #[test]
    fn desktop_referral_delivery_is_exact_subject_only() {
        assert!(may_deliver_for_subject(
            Some("subject-a"),
            Some("subject-a")
        ));
        assert!(!may_deliver_for_subject(
            Some("subject-a"),
            Some("subject-b")
        ));
        assert!(!may_deliver_for_subject(Some("subject-a"), None));
    }

    #[test]
    fn desktop_referral_ack_classification_retries_legacy_and_unknown_shapes() {
        assert_eq!(
            classify_referral_response(
                200,
                r#"{"referral":{"status":"bound"},"anonId":" vyg-1 "}"#
            ),
            ReferralDelivery::Delivered(ReferralStatus::Bound)
        );
        assert_eq!(
            classify_referral_response(200, r#"{"referral":{"status":"none"}}"#),
            ReferralDelivery::Delivered(ReferralStatus::None)
        );
        assert_eq!(
            classify_referral_response(200, r#"{"referral":{"status":"expired"}}"#),
            ReferralDelivery::Delivered(ReferralStatus::Expired)
        );
        assert_eq!(
            classify_referral_response(403, r#"{"referral":{"status":"rejected"}}"#),
            ReferralDelivery::Delivered(ReferralStatus::Rejected)
        );
        for (status, body) in [
            (204, ""),
            (200, r#"{"anonId":"legacy"}"#),
            (200, r#"{"referral":{"status":"surprise"}}"#),
            (202, r#"{"referral":{"status":"bound"}}"#),
            (403, r#"{"referral":{"status":"bound"},"anonId":42}"#),
            (429, ""),
            (500, ""),
        ] {
            assert_eq!(
                classify_referral_response(status, body),
                ReferralDelivery::Retry
            );
        }
    }

    #[test]
    fn desktop_referral_ack_ignores_non_string_optional_anon_id() {
        for (status, body, expected) in [
            (
                200,
                r#"{"referral":{"status":"bound"},"anonId":42}"#,
                ReferralStatus::Bound,
            ),
            (
                200,
                r#"{"referral":{"status":"none"},"anonId":{"id":"vyg-1"}}"#,
                ReferralStatus::None,
            ),
            (
                200,
                r#"{"referral":{"status":"expired"},"anonId":42}"#,
                ReferralStatus::Expired,
            ),
            (
                200,
                r#"{"referral":{"status":"rejected"},"anonId":{"id":"vyg-1"}}"#,
                ReferralStatus::Rejected,
            ),
            (
                403,
                r#"{"referral":{"status":"rejected"},"anonId":42}"#,
                ReferralStatus::Rejected,
            ),
        ] {
            let ack = parse_referral_ack(status, body).expect("recognized status is terminal");
            assert_eq!(ack.referral.status, expected);
            assert_eq!(ack.anon_id, None);
        }
    }

    #[test]
    fn desktop_referral_retry_backoff_caps_at_hourly_retention() {
        assert_eq!(next_retry_at_ms(10_000, 0), 11_000);
        assert_eq!(next_retry_at_ms(10_000, 8), 3_610_000);
        assert_eq!(next_attempt_count(7), 8);
        assert_eq!(next_attempt_count(8), 8);
    }

    #[test]
    fn desktop_referral_expiry_is_seven_days_and_distinctly_removable() {
        let home = tempfile::tempdir().expect("temp home");
        let path = queue_path(&home);
        enqueue(
            &path,
            ReferralReceipt::new("fresh", PENDING_EXPIRY_MS + 3_000),
        )
        .expect("fresh");
        enqueue(&path, ReferralReceipt::new("expired", 2_000)).expect("expired");

        let expired = expire_old(&path, 2_000 + PENDING_EXPIRY_MS).expect("expire old");

        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].nonce, "expired");
        let retained = read_queue(&path).expect("read retained");
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].nonce, "fresh");
    }

    #[test]
    fn desktop_referral_queue_never_serializes_tokens_or_authorize_urls() {
        let home = tempfile::tempdir().expect("temp home");
        let path = queue_path(&home);
        let mut receipt = ReferralReceipt::new("nonce-a", 100);
        receipt.authorized_subject = Some("subject-a".to_string());
        enqueue(&path, receipt).expect("enqueue");
        let body = fs::read_to_string(path).expect("read queue JSON");
        assert!(!body.contains("access_token"));
        assert!(!body.contains("refresh_token"));
        assert!(!body.contains("id_token"));
        assert!(!body.contains("https://"));
        let json: serde_json::Value = serde_json::from_str(&body).expect("queue JSON");
        let receipt = &json["receipts"][0];
        assert!(receipt.get("authorizeUrl").is_none());
        assert!(receipt.get("rawAuthorizeUrl").is_none());
        assert!(receipt.get("signedReferralProof").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn desktop_referral_queue_and_lock_are_private_on_creation() {
        use std::os::unix::fs::PermissionsExt;

        let home = tempfile::tempdir().expect("temp home");
        let path = queue_path(&home);
        enqueue(&path, ReferralReceipt::new("nonce-a", 100)).expect("enqueue");

        let queue_mode = fs::metadata(&path)
            .expect("queue metadata")
            .permissions()
            .mode();
        let lock_mode = fs::metadata(path.parent().unwrap().join(LOCK_FILE_NAME))
            .expect("lock metadata")
            .permissions()
            .mode();
        assert_eq!(queue_mode & 0o777, 0o600);
        assert_eq!(lock_mode & 0o777, 0o600);
    }

    #[test]
    fn desktop_referral_duplicate_ack_removal_does_not_drop_concurrent_enqueue() {
        let home = tempfile::tempdir().expect("temp home");
        let path = queue_path(&home);
        enqueue(&path, ReferralReceipt::new("done", 100)).expect("done");
        enqueue(&path, ReferralReceipt::new("later", 200)).expect("later");
        remove_nonce(&path, "done").expect("remove delivered");
        let retained = read_queue(&path).expect("read retained");
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].nonce, "later");
    }

    #[test]
    fn desktop_referral_body_adds_protocol_without_credentials() {
        let body = referral_link_body("nonce-a", Some("vyg-7"));
        assert_eq!(body["link"], "nonce-a");
        assert_eq!(body["referralProtocol"], REFERRAL_PROTOCOL_VERSION);
        assert_eq!(body["anonId"], "vyg-7");
        let serialized = serde_json::to_string(&body).expect("serialize body");
        assert!(!serialized.contains("Bearer"));
        assert!(!serialized.contains("access_token"));
    }

    #[test]
    fn desktop_referral_native_wiring_contracts_are_ci_visible() {
        let commands =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/sync/src-tauri/src/commands");
        let desktop_auth = fs::read_to_string(commands.join("desktop_auth.rs"))
            .expect("read native desktop auth wiring");
        let oauth =
            fs::read_to_string(commands.join("oauth.rs")).expect("read native OAuth wiring");

        let desktop_auth_production = desktop_auth
            .split("#[cfg(test)]")
            .next()
            .expect("native production wiring");
        assert!(!desktop_auth_production.contains("bearer_override"));
        assert!(desktop_auth.contains("static DESKTOP_REFERRAL_WAKE: tokio::sync::Notify"));
        assert!(desktop_auth.contains("compare_exchange(false, true"));
        assert!(desktop_auth.contains("earliest_attempt_at_for_subject_async"));
        assert!(desktop_auth.contains(".timeout(DESKTOP_REFERRAL_HTTP_TIMEOUT)"));
        assert!(desktop_auth.contains("super::auth::refresh_tokens(app.clone()).await?"));
        assert!(desktop_auth.contains("session.status == super::auth::AuthSessionStatus::Active"));

        let continuation = desktop_auth
            .split("pub async fn desktop_continuation_confirm(")
            .nth(1)
            .expect("continuation completion")
            .split("pub async fn desktop_continuation_cancel(")
            .next()
            .expect("continuation completion body");
        assert_binding_precedes_persistence_and_detached_wake(
            continuation,
            "super::auth::complete_auth_session(&app, &tokens).await",
        );

        let provider = oauth
            .split("pub async fn oauth_exchange_code(")
            .nth(1)
            .expect("provider completion")
            .split("pub async fn oauth_listen_for_code")
            .next()
            .expect("provider completion body");
        assert_binding_precedes_persistence_and_detached_wake(
            provider,
            "crate::commands::auth::complete_auth_session(&app, &tokens).await",
        );

        let post = desktop_auth
            .split("async fn post_desktop_referral_receipt(")
            .nth(1)
            .expect("native referral post")
            .split("async fn drain_desktop_referrals")
            .next()
            .expect("native referral post body");
        assert!(post.contains("resolve_notification_auth_snapshot(app).await?"));
        assert!(post.contains("with_current_notification_mutation("));
        assert!(post.contains("with_current_notification_auth_snapshot("));
        assert!(post.contains("notification_identity_from_bearer_token(&auth.access_token)"));
        assert!(post.contains("Some(auth.identity.as_str())"));
        let leased_post = post
            .split("with_current_notification_mutation(")
            .nth(1)
            .expect("leased referral mutation")
            .split("let Some(response) = response")
            .next()
            .expect("leased response boundary");
        assert!(leased_post.contains(".send()"));
        assert!(leased_post.contains(".text()"));
        assert!(
            post.find("let Some(response) = response")
                .expect("lease return")
                < post
                    .find("refresh_tokens(app.clone()).await?")
                    .expect("401 refresh after lease return")
        );
        assert!(post.contains("ReferralDelivery::Held"));
        assert!(post.contains("parse_referral_ack"));
        assert!(post.contains("cdp_mirror::note_signin_link_visitor(anon_id)"));

        let arm = oauth
            .split("pub(crate) fn arm_oauth_flow(")
            .nth(1)
            .expect("OAuth arming")
            .split("pub(crate) fn set_pending_referral_nonce")
            .next()
            .expect("OAuth arming body");
        let discard = arm
            .find("discard_unbound_desktop_referral_nonce(nonce)")
            .expect("superseded unbound referral cleanup");
        let overwrite = arm
            .find("*guard = Some(PendingPkce")
            .expect("new PKCE overwrite");
        assert!(arm.contains("guard.take().and_then(|pending| pending.referral_nonce)"));
        assert!(discard < overwrite);
    }

    fn assert_binding_precedes_persistence_and_detached_wake(source: &str, completion_call: &str) {
        let bind = source
            .find("authorize_desktop_referral_for_tokens(&tokens, nonce)")
            .expect("binding call");
        let persist = source
            .find(completion_call)
            .expect("credential persistence call");
        let wake = source
            .find("flush_pending_desktop_referrals(&app)")
            .expect("detached scheduler wake");
        assert!(bind < persist && persist < wake);
        assert!(source[bind..persist].contains("?;"));
        let ambiguous_failure = source[persist..]
            .split("return Err(error);")
            .next()
            .expect("ambiguous completion failure branch");
        assert!(ambiguous_failure.contains("Err(error) =>"));
        assert!(ambiguous_failure.contains("flush_pending_desktop_referrals(&app)"));
        assert!(!ambiguous_failure.contains("discard_unbound_desktop_referral_nonce"));
    }
}
