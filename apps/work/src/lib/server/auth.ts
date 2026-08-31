/**
 * Web auth adapter (US-006) — thin SvelteKit/$env layer over @hq/auth.
 *
 * The platform-pure Cognito flow (authorize URL, token exchange, id_token
 * verification, logout URL, PKCE, providers, cookie NAME constants) lives in
 * @hq/auth so web, desktop, and mobile share ONE implementation. This module
 * only:
 *   - assembles the AuthConfig from SvelteKit's $env (public + private split);
 *   - decides the test-JWKS seam HERE (the env gate stays in web): the local
 *     JWKS is used ONLY when COGNITO_TEST_JWKS is set AND the deployment is not
 *     Vercel production (VERCEL_ENV === "production" ignores the override);
 *   - re-exports the pure helpers with the SAME public API the routes/hooks
 *     already import, so callers barely change.
 *
 * The id_token lives in an httpOnly cookie set by the routes/hooks. It never
 * appears in page data; the authenticated `/api/auth/token` bridge
 * deliberately exposes it to browser memory so the web shell can call hq-pro
 * directly with a Bearer. It is not persisted in browser storage.
 */

import { env } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import type { JSONWebKeySet } from "jose";

import {
  type AuthConfig,
  type Session,
  VAULT_AWS_REGION,
  VAULT_CLIENT_ID,
  VAULT_HOSTED_UI_DOMAIN,
  VAULT_USER_POOL_ID,
  WEB_DEV_APP_ORIGIN,
  isSigninConfigured as authIsSigninConfigured,
  vaultIssuer,
  verifyIdToken as authVerifyIdToken,
} from "@hq/auth";

// Re-export the shared types + cookie names + pure helpers so existing route
// and hook imports (`$lib/server/auth`) keep working unchanged.
export type { AuthConfig, Session };
export {
  ID_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  PKCE_VERIFIER_COOKIE,
  OAUTH_STATE_COOKIE,
  POST_LOGIN_REDIRECT_COOKIE,
  randomToken,
  pkceChallenge,
  refreshTokens,
} from "@hq/auth";

/**
 * The test-JWKS env gate — kept in the WEB adapter, not the shared lib. Returns
 * the parsed local JWKS ONLY when COGNITO_TEST_JWKS is present AND this is not
 * Vercel production, so CI/E2E can mint RS256 tokens with a committed test key
 * without ever weakening production (VERCEL_ENV === "production" → undefined).
 */
function resolveTestJwks(): JSONWebKeySet | undefined {
  const raw = env.COGNITO_TEST_JWKS;
  if (raw && env.VERCEL_ENV !== "production") {
    return JSON.parse(raw) as JSONWebKeySet;
  }
  return undefined;
}

export interface AuthConfigOptions {
  /** Request origin (`url.origin`). Used when PUBLIC_APP_ORIGIN is unset. */
  origin?: string;
}

/**
 * Local `vite dev` / `vite preview` should sign in with zero env files —
 * same vault-client the desktop app already defaults to. Any Vercel
 * deployment (preview or production) stays fail-closed: it must supply
 * its own Cognito + PUBLIC_APP_ORIGIN (work-web, not vault-client).
 */
export function useLocalVaultClientDefaults(
  runtime: { vercel?: string; vercelEnv?: string } = {
    vercel: env.VERCEL,
    vercelEnv: env.VERCEL_ENV,
  },
): boolean {
  return !runtime.vercel && runtime.vercelEnv !== "production";
}

export function authConfig(opts: AuthConfigOptions = {}): AuthConfig {
  const local = useLocalVaultClientDefaults();
  const region = env.AWS_REGION ?? (local ? VAULT_AWS_REGION : "us-east-1");
  const pool = env.COGNITO_USER_POOL_ID ?? (local ? VAULT_USER_POOL_ID : "");
  const issuer = env.COGNITO_ISSUER ?? (pool ? vaultIssuer(region, pool) : "");
  return {
    clientId: env.COGNITO_CLIENT_ID ?? (local ? VAULT_CLIENT_ID : ""),
    hostedUiDomain:
      env.COGNITO_HOSTED_UI_DOMAIN ?? (local ? VAULT_HOSTED_UI_DOMAIN : ""),
    issuer,
    // PUBLIC_-prefixed vars are excluded from $env/dynamic/private by
    // SvelteKit (publicPrefix), so this MUST come from the public env —
    // reading it from the private env silently yields "" in production.
    // Locally we fall back to the request origin, then localhost:3000.
    appOrigin:
      publicEnv.PUBLIC_APP_ORIGIN ||
      opts.origin ||
      (local ? WEB_DEV_APP_ORIGIN : ""),
    testJwks: resolveTestJwks(),
  };
}

/** Hosted-UI flow needs the domain + client id + an origin to return to. */
export function isSigninConfigured(config: AuthConfig = authConfig()): boolean {
  return authIsSigninConfigured(config);
}

/**
 * Verify an id_token against the current AuthConfig and distill the safe
 * session fields. Returns null on any failure — callers treat that as
 * signed-out, never as an error page.
 */
export function verifyIdToken(token: string): Promise<Session | null> {
  return authVerifyIdToken(authConfig(), token);
}
