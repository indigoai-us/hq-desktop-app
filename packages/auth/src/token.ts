/**
 * Exchange an authorization code (+ PKCE verifier) for tokens at the Cognito
 * hosted-UI /oauth2/token endpoint.
 *
 * `fetch` is INJECTED — no global assumptions — so the same code runs under a
 * SvelteKit request's `event.fetch`, the browser, or a Tauri command.
 */

import type { AuthConfig } from "./types.js";

export interface ExchangeParams {
  /** Authorization code returned to the callback. */
  code: string;
  /** The PKCE verifier that produced the authorize code_challenge. */
  codeVerifier: string;
  /** Must match the redirect_uri used on the authorize request. */
  redirectUri: string;
  /** Injected fetch implementation. */
  fetch: typeof fetch;
}

export interface RefreshParams {
  /** Refresh token from a prior authorization-code exchange. */
  refreshToken: string;
  /** Injected fetch implementation. */
  fetch: typeof fetch;
}

export interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  [key: string]: unknown;
}

/**
 * Thrown when the token endpoint responds non-2xx. Callers map this to their
 * own transport error (e.g. web returns a 400 "token exchange failed").
 */
export class TokenExchangeError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`token exchange failed (${status})`);
    this.name = "TokenExchangeError";
    this.status = status;
  }
}

export async function exchangeCodeForTokens(
  config: AuthConfig,
  params: ExchangeParams,
): Promise<TokenResponse> {
  const res = await params.fetch(
    `https://${config.hostedUiDomain}/oauth2/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
      }),
    },
  );
  if (!res.ok) throw new TokenExchangeError(res.status);
  return (await res.json()) as TokenResponse;
}

/**
 * Exchange a refresh token for a new id_token / access_token pair. Cognito
 * may omit `refresh_token` in the response when rotation is off — callers
 * must keep the token they just sent in that case.
 */
export async function refreshTokens(
  config: AuthConfig,
  params: RefreshParams,
): Promise<TokenResponse> {
  const res = await params.fetch(
    `https://${config.hostedUiDomain}/oauth2/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: params.refreshToken,
      }),
    },
  );
  if (!res.ok) throw new TokenExchangeError(res.status);
  return (await res.json()) as TokenResponse;
}
