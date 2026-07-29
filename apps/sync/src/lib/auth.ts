/**
 * Decide whether the sign-in step can be skipped. `get_auth_state` validates
 * freshness (including one silent refresh retry), so raw token-file presence
 * must never override its verdict: that was how an expired refresh token
 * reasserted a signed-in state on every launch.
 */
export function shouldSkipSignIn(
  state: { authenticated: boolean },
): boolean {
  return state.authenticated;
}

/**
 * Startup can race a short-lived backend pre-auth window even after the
 * frontend auth snapshot flips true. Those expected authorization misses are
 * not operational errors and must not fail live-preauth's console-error gate.
 */
export function isExpectedUnauthenticatedError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : String(error);
  return /\bnot signed in\b|\bunauthenticated\b/i.test(message);
}
