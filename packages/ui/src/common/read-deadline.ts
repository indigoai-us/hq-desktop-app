/**
 * Shared loading contract for page reads (BLANK-3, replaces the BLANK-1
 * 12-second bound). No timer turns a pending read into a failure: the request
 * stays alive and its result renders whenever it arrives. "Could not read"
 * with Try again is only for a read that really failed (rejected, non-2xx,
 * network error).
 *
 * While a read is pending the page shows ReadLoader: an animated loader at
 * once, a rotating waiting line from LOADING_MESSAGE_AFTER_MS, and a quiet
 * Try again beside it from LOADING_RETRY_AFTER_MS, so nobody is ever stuck.
 *
 * Thresholds from measured reads (Indigo Team, 58 members): 3.9-4.8 s alone,
 * up to 8.2 s with six reads at once. Most reads finish under 3 s, so the
 * line only shows when a wait is noticeable; 60 s is well past the slowest
 * healthy read and past the native 15 s per-request timeout chain.
 */
export const LOADING_MESSAGE_AFTER_MS = 3_000;
export const LOADING_MESSAGE_ROTATE_MS = 4_000;
export const LOADING_RETRY_AFTER_MS = 60_000;
