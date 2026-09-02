/**
 * Pure predicates over an assembled {@link AuthConfig}. The config itself is
 * built per-surface (host reads its own env/settings) — this module never
 * touches env.
 */

import type { AuthConfig } from "./types.js";

/** Hosted-UI flow needs the domain, client id, issuer, and an origin to return to. */
export function isSigninConfigured(config: AuthConfig): boolean {
  return Boolean(
    config.hostedUiDomain &&
      config.clientId &&
      config.issuer &&
      config.appOrigin,
  );
}
