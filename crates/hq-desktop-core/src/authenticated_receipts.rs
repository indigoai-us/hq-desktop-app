//! Pure delivery policy for desktop-authenticated telemetry receipts.
//!
//! The Tauri shell owns credentials and durable file I/O. This module owns the
//! account binding and retry decisions so they can be exercised on hosts that
//! cannot compile the native WebKit/GTK application.

/// The maximum number of short-interval automatic retries before a receipt is
/// retained for a later authenticated app session. A receipt is never dropped
/// merely because the retry budget was spent.
pub const MAX_AUTOMATIC_RECEIPT_ATTEMPTS: u8 = 8;
const INITIAL_RETRY_DELAY_MS: i64 = 1_000;
const MAX_RETRY_DELAY_MS: i64 = 60 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptHttpDisposition {
    Delivered,
    Retry,
    Rejected,
}

/// Only malformed or otherwise permanent client validation responses discard a
/// receipt. Credential turnover (401), throttling (429), and server failures
/// remain retryable.
pub fn classify_receipt_http_status(status: u16) -> ReceiptHttpDisposition {
    if (200..300).contains(&status) {
        ReceiptHttpDisposition::Delivered
    } else if status == 401 || status == 429 || status >= 500 {
        ReceiptHttpDisposition::Retry
    } else if (400..500).contains(&status) {
        ReceiptHttpDisposition::Rejected
    } else {
        ReceiptHttpDisposition::Retry
    }
}

/// A receipt can only travel with the identity that authorized its creation.
/// Unbound legacy rows are deliberately retained, never sent under a newly
/// signed-in account.
pub fn may_deliver_for_account(
    authorized_account_id: Option<&str>,
    active_account_id: Option<&str>,
) -> bool {
    matches!(
        (authorized_account_id, active_account_id),
        (Some(authorized), Some(active)) if authorized == active
    )
}

/// Exponential backoff with a one-hour cap. After the short automatic budget
/// is spent, the cap keeps an unresolved receipt in custody for a later session
/// without creating a tight retry loop.
pub fn next_receipt_retry_at_ms(now_ms: i64, prior_attempts: u8) -> i64 {
    let delay = if prior_attempts >= MAX_AUTOMATIC_RECEIPT_ATTEMPTS {
        MAX_RETRY_DELAY_MS
    } else {
        INITIAL_RETRY_DELAY_MS
            .saturating_mul(1_i64.checked_shl(prior_attempts as u32).unwrap_or(i64::MAX))
            .min(MAX_RETRY_DELAY_MS)
    };
    now_ms.saturating_add(delay)
}

/// Retained attempts saturate at the automatic budget. The row stays durable;
/// saturation merely bounds immediate retry pressure.
pub fn next_receipt_attempt_count(prior_attempts: u8) -> u8 {
    prior_attempts
        .saturating_add(1)
        .min(MAX_AUTOMATIC_RECEIPT_ATTEMPTS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_authorizing_account_can_deliver_a_receipt() {
        assert!(may_deliver_for_account(Some("person-a"), Some("person-a")));
        assert!(!may_deliver_for_account(Some("person-a"), Some("person-b")));
        assert!(!may_deliver_for_account(Some("person-a"), None));
        assert!(!may_deliver_for_account(None, Some("person-a")));
    }

    #[test]
    fn credential_turnover_throttle_and_server_errors_retry() {
        for status in [401, 429, 500, 503] {
            assert_eq!(
                classify_receipt_http_status(status),
                ReceiptHttpDisposition::Retry
            );
        }
        assert_eq!(
            classify_receipt_http_status(400),
            ReceiptHttpDisposition::Rejected
        );
        assert_eq!(
            classify_receipt_http_status(422),
            ReceiptHttpDisposition::Rejected
        );
    }

    #[test]
    fn retry_backoff_is_bounded_without_discarding_the_receipt() {
        assert_eq!(next_receipt_retry_at_ms(10_000, 0), 11_000);
        assert_eq!(next_receipt_retry_at_ms(10_000, 20), 3_610_000);
        assert_eq!(next_receipt_attempt_count(7), 8);
        assert_eq!(next_receipt_attempt_count(8), 8);
    }
}
