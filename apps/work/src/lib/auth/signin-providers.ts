/**
 * Re-export shim — the sign-in provider → Cognito identity-provider map now
 * lives in @hq/auth (shared across web, desktop, mobile). Kept at this path so
 * existing `$lib/auth/signin-providers` imports (and their test) keep working
 * unchanged. See packages/auth/src/providers.ts.
 */

export {
  SIGNIN_PROVIDERS,
  SIGNIN_PROVIDER_CONFIG,
  isAllowedSignInProvider,
  isEnabledSignInProvider,
  type SignInProvider,
  type SignInProviderConfig,
} from "@hq/auth";
