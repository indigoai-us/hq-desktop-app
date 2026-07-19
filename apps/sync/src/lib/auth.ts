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
