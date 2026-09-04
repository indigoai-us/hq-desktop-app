/**
 * Build the Cognito hosted-UI /oauth2/authorize URL for the
 * authorization-code + PKCE flow.
 *
 * Host-agnostic: the caller supplies the fully-formed `redirectUri` (web dev:
 * http://localhost:3000/auth/callback, web prod:
 * https://work.hq.computer/auth/callback, desktop:
 * hq-work://app/connect/cognito-callback) and PKCE/state material.
 */

import type { AuthConfig } from "./types.js";

export interface AuthorizeParams {
  /** Fully-formed redirect_uri registered on the Cognito app client. */
  redirectUri: string;
  /** CSRF state (echoed back on the callback). */
  state: string;
  /** S256 PKCE code challenge. */
  codeChallenge: string;
  /** Cognito `identity_provider` — when set, the hosted chooser is skipped. */
  identityProvider?: string;
  /** OAuth scopes; defaults to Cognito's openid/email/profile. */
  scope?: string;
}

export function buildAuthorizeUrl(
  config: AuthConfig,
  params: AuthorizeParams,
): string {
  const authorize = new URL(
    `https://${config.hostedUiDomain}/oauth2/authorize`,
  );
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("redirect_uri", params.redirectUri);
  authorize.searchParams.set("scope", params.scope ?? "openid email profile");
  authorize.searchParams.set("state", params.state);
  if (params.identityProvider) {
    authorize.searchParams.set("identity_provider", params.identityProvider);
  }
  authorize.searchParams.set("code_challenge", params.codeChallenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return authorize.toString();
}
