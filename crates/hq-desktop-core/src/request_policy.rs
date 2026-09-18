//! Shared 429 / 503 request policy for the Rust API clients (R2).
//!
//! The desktop app's `reqwest` calls into hq-pro had no throttle handling: a
//! 429 came back as an ordinary HTTP error and the caller's next scheduled
//! attempt fired at exactly the same rate. Across a fleet in phase, that keeps
//! a brief server throttle alive indefinitely.
//!
//! [`send_with_retry`] wraps a `RequestBuilder` and retries only on 429 and
//! 503, honouring `Retry-After` when the server sends one and using
//! full-jitter exponential backoff when it does not. The final response is
//! returned unchanged, so every caller keeps the error it already handles — a
//! throttle is a server answer, never a panic.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::{RequestBuilder, Response, StatusCode};

/// Backoff base for the first retry, before jitter.
pub const RETRY_BASE_MS: u64 = 1_000;

/// Ceiling on a single computed backoff, and on an honoured `Retry-After`.
pub const RETRY_CAP_MS: u64 = 60_000;

/// Attempts in total, including the first. 4 ⇒ up to 3 retries.
pub const RETRY_MAX_ATTEMPTS: u32 = 4;

/// Statuses the policy retries.
pub fn is_retryable_status(status: u16) -> bool {
    status == 429 || status == 503
}

/// `Retry-After` in milliseconds: delta-seconds ("2") or an HTTP-date
/// ("Wed, 21 Oct 2015 07:28:00 GMT"). None when absent or unparseable; a date
/// already in the past yields `Some(0)`, which is the server saying "now".
pub fn parse_retry_after_ms(raw: Option<&str>, now_epoch_ms: i64) -> Option<u64> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    if text.chars().all(|c| c.is_ascii_digit()) {
        return text.parse::<u64>().ok().map(|s| s.saturating_mul(1_000));
    }
    let at = chrono::DateTime::parse_from_rfc2822(text).ok()?;
    let at_ms = at.timestamp_millis();
    Some((at_ms - now_epoch_ms).max(0) as u64)
}

/// `Retry-After` as the server sent it.
pub fn retry_after_header(response: &Response) -> Option<String> {
    let raw = response.headers().get(reqwest::header::RETRY_AFTER)?;
    let text = raw.to_str().ok()?.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

/// Full-jitter exponential backoff: `unit * min(cap, base * 2^attempt)`.
///
/// `unit` is a caller-supplied value in `[0, 1)`, so tests are deterministic.
/// Full jitter, rather than a band around the nominal delay, is what actually
/// de-phases a fleet.
pub fn full_jitter_backoff_ms(attempt: u32, unit: f64, base_ms: u64, cap_ms: u64) -> u64 {
    let exponent = attempt.min(30);
    let ceiling = cap_ms.min(base_ms.saturating_mul(1u64 << exponent));
    let unit = unit.clamp(0.0, 1.0);
    (ceiling as f64 * unit) as u64
}

/// A cheap `[0, 1)` draw. Jitter needs de-phasing, not cryptographic quality,
/// and this keeps the crate free of a random-number dependency.
fn unit_random() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    // xorshift the nanosecond counter so successive calls inside one
    // millisecond do not draw near-identical values.
    let mut x = nanos
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1);
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
    x ^= x >> 33;
    (x % 1_000_000) as f64 / 1_000_000.0
}

fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// How long to wait before retrying, or None when this response should be
/// returned to the caller as-is.
///
/// Pure, so the decision is unit-tested without a server: a non-retryable
/// status, an exhausted attempt budget, or a `Retry-After` longer than the cap
/// all stop the loop. Refusing to sleep off an over-cap `Retry-After` is
/// deliberate — the caller sees its normal error instead of the app hanging.
pub fn retry_delay_ms(
    status: u16,
    retry_after: Option<&str>,
    attempt: u32,
    max_attempts: u32,
    unit: f64,
    now_epoch_ms: i64,
) -> Option<u64> {
    if !is_retryable_status(status) {
        return None;
    }
    if attempt + 1 >= max_attempts {
        return None;
    }
    match parse_retry_after_ms(retry_after, now_epoch_ms) {
        Some(ms) if ms > RETRY_CAP_MS => None,
        Some(ms) => Some(ms),
        None => Some(full_jitter_backoff_ms(
            attempt,
            unit,
            RETRY_BASE_MS,
            RETRY_CAP_MS,
        )),
    }
}

/// Send a request, retrying 429/503 under the shared policy.
///
/// Falls back to a single send when the builder cannot be cloned (a streaming
/// body), so no call site loses its request by adopting this.
pub async fn send_with_retry(req: RequestBuilder) -> Result<Response, reqwest::Error> {
    send_with_retry_attempts(req, RETRY_MAX_ATTEMPTS).await
}

async fn send_with_retry_attempts(
    req: RequestBuilder,
    max_attempts: u32,
) -> Result<Response, reqwest::Error> {
    let mut attempt: u32 = 0;
    loop {
        let Some(next) = req.try_clone() else {
            return req.send().await;
        };
        let response = next.send().await?;
        let status: StatusCode = response.status();
        let delay = retry_delay_ms(
            status.as_u16(),
            retry_after_header(&response).as_deref(),
            attempt,
            max_attempts,
            unit_random(),
            now_epoch_ms(),
        );
        let Some(delay_ms) = delay else {
            return Ok(response);
        };
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        attempt += 1;
    }
}

/// `send_retrying()` on any `RequestBuilder`, so adopting the policy is a
/// one-word change at each call site and the request chain stays readable.
pub trait RequestBuilderExt {
    fn send_retrying(
        self,
    ) -> impl std::future::Future<Output = Result<Response, reqwest::Error>> + Send;
}

impl RequestBuilderExt for RequestBuilder {
    fn send_retrying(
        self,
    ) -> impl std::future::Future<Output = Result<Response, reqwest::Error>> + Send {
        send_with_retry(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_429_and_503_are_retryable() {
        assert!(is_retryable_status(429));
        assert!(is_retryable_status(503));
        for status in [200, 400, 401, 404, 500, 502, 504] {
            assert!(!is_retryable_status(status), "{status}");
        }
    }

    #[test]
    fn parses_delta_seconds() {
        assert_eq!(parse_retry_after_ms(Some("2"), 0), Some(2_000));
        assert_eq!(parse_retry_after_ms(Some(" 30 "), 0), Some(30_000));
    }

    #[test]
    fn parses_http_date_and_floors_at_zero() {
        let raw = "Wed, 21 Oct 2015 07:28:00 GMT";
        let at = chrono::DateTime::parse_from_rfc2822(raw)
            .unwrap()
            .timestamp_millis();
        assert_eq!(parse_retry_after_ms(Some(raw), at - 5_000), Some(5_000));
        assert_eq!(parse_retry_after_ms(Some(raw), at + 5_000), Some(0));
    }

    #[test]
    fn missing_or_junk_retry_after_is_none() {
        assert_eq!(parse_retry_after_ms(None, 0), None);
        assert_eq!(parse_retry_after_ms(Some(""), 0), None);
        assert_eq!(parse_retry_after_ms(Some("soon"), 0), None);
    }

    #[test]
    fn retry_after_wins_over_backoff() {
        assert_eq!(
            retry_delay_ms(429, Some("2"), 0, 4, 0.0, 0),
            Some(2_000),
            "a 429 must never be retried immediately"
        );
    }

    #[test]
    fn backoff_is_jittered_within_the_ceiling() {
        for attempt in 0..4u32 {
            let ceiling = RETRY_CAP_MS.min(RETRY_BASE_MS << attempt);
            let low = retry_delay_ms(429, None, attempt, 8, 0.0, 0).unwrap();
            let high = retry_delay_ms(429, None, attempt, 8, 0.999_999, 0).unwrap();
            assert!(
                low <= high && high < ceiling + 1,
                "{attempt}: {low}..{high}"
            );
            assert!(high > ceiling / 2, "{attempt}: jitter should reach the top");
        }
    }

    #[test]
    fn stops_on_non_retryable_status_and_on_the_last_attempt() {
        assert_eq!(retry_delay_ms(500, None, 0, 4, 0.5, 0), None);
        assert_eq!(retry_delay_ms(429, None, 3, 4, 0.5, 0), None);
    }

    #[test]
    fn refuses_to_sleep_off_an_over_cap_retry_after() {
        assert_eq!(retry_delay_ms(503, Some("3600"), 0, 4, 0.5, 0), None);
    }
}
