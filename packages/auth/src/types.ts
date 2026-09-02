/**
 * Platform-agnostic auth core types (@hq/auth).
 *
 * These describe the Cognito hosted-UI authorization-code + PKCE flow shared
 * by every surface (web dev localhost, web prod work.hq.computer, desktop
 * hq-work:// deep-link, mobile). NO SvelteKit, NO $env, NO Node-only APIs live
 * here — the config is ASSEMBLED per-platform and passed in.
 */

import type { JSONWebKeySet } from "jose";

/** Distilled, safe session fields (never carries the raw id_token). */
export interface Session {
  sub: string;
  email: string | null;
  /** JWT `name` claim from the `profile` scope; null when absent. */
  name: string | null;
  /** Token expiry, epoch milliseconds. */
  expiresAt: number;
  /**
   * True only for a DEV-ONLY synthetic local session assembled by a host
   * surface (e.g. web's lib/server/local-dev-session.ts). Never set on a real
   * Cognito session.
   */
  local?: boolean;
}

/**
 * Everything the pure auth functions need, assembled per surface.
 *
 * The test-JWKS seam is DATA-DRIVEN here: when `testJwks` is present,
 * {@link verifyIdToken} verifies against it instead of the remote pool JWKS.
 * The decision of WHETHER to populate `testJwks` (the env gate — set only when
 * a test JWKS env var is present AND the deployment is not production) lives in
 * the host adapter, NOT in this shared library.
 */
export interface AuthConfig {
  clientId: string;
  hostedUiDomain: string;
  issuer: string;
  appOrigin: string;
  /**
   * Optional local JWK set for the CI/E2E test seam. When set, id_token
   * verification runs against this JWKS instead of `${issuer}/.well-known/
   * jwks.json`. Left undefined in production so real tokens verify against the
   * live pool.
   */
  testJwks?: JSONWebKeySet;
}
