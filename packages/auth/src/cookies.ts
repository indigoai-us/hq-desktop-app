/**
 * Shared cookie NAME constants.
 *
 * Only the names are shared — the actual cookie set/get (httpOnly, sameSite,
 * conditional-secure, maxAge) stays per-platform because it depends on the
 * host's request/response primitives (SvelteKit `cookies`, Tauri store, etc.).
 */

export const ID_TOKEN_COOKIE = "hq_id_token";
/**
 * Long-lived refresh token. Hosts persist this separately from `hq_id_token`
 * so the 1-hour id_token can expire without signing the user out.
 */
export const REFRESH_TOKEN_COOKIE = "hq_refresh_token";
export const PKCE_VERIFIER_COOKIE = "hq_pkce_verifier";
export const OAUTH_STATE_COOKIE = "hq_oauth_state";
/**
 * Short-lived cookie carrying the safe same-origin destination to land on
 * after the OAuth round-trip. Set when the flow begins, consumed + deleted by
 * the callback. Never trusted raw — re-normalized on read.
 */
export const POST_LOGIN_REDIRECT_COOKIE = "hq_post_login_redirect";
