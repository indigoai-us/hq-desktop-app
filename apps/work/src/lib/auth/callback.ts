/**
 * Re-export shim — the safe same-origin return-to guard now lives in @hq/auth
 * (shared across web, desktop, mobile). Kept at this path so existing
 * `$lib/auth/callback` imports (and their test) keep working unchanged. See
 * packages/auth/src/callback.ts.
 */

export {
  normalizeCallback,
  firstParam,
  searchParamsToSignIn,
  type SignInSearchParams,
} from "@hq/auth";
