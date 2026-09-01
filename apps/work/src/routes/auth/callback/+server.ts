/**
 * GET /auth/callback — finish the authorization-code + PKCE flow.
 *
 * Validates the CSRF state, exchanges the code (with the PKCE verifier) at
 * the Hosted UI /oauth2/token, verifies the returned id_token against the
 * pool JWKS, and parks id_token + refresh_token in httpOnly cookies (id
 * cookie maxAge pinned to JWT expiry; refresh cookie lasts 30 days). This
 * callback only redirects; the separate authenticated token bridge delivers
 * the current id_token into browser memory for direct hq-pro calls.
 */

import { exchangeCodeForTokens } from "@hq/auth";
import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import { normalizeCallback } from "$lib/auth/callback";
import {
  OAUTH_STATE_COOKIE,
  PKCE_VERIFIER_COOKIE,
  POST_LOGIN_REDIRECT_COOKIE,
  authConfig,
  isSigninConfigured,
  verifyIdToken,
} from "$lib/server/auth";
import { writeSessionCookies } from "$lib/server/session-cookies";

/** Default post-login home — the root '/' IS the V2 desktop shell now (the
 * legacy (app)/chat route was removed), so an unspecified destination lands
 * on the shell. */
const DEFAULT_DESTINATION = "/";

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

export const GET: RequestHandler = async ({ url, cookies, fetch }) => {
  const config = authConfig({ origin: url.origin });
  if (!isSigninConfigured(config)) return badRequest("auth not configured");

  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");
  const state = url.searchParams.get("state");
  const expectedState = cookies.get(OAUTH_STATE_COOKIE);
  const verifier = cookies.get(PKCE_VERIFIER_COOKIE);
  cookies.delete(OAUTH_STATE_COOKIE, { path: "/" });
  cookies.delete(PKCE_VERIFIER_COOKIE, { path: "/" });

  if (!state || !expectedState || state !== expectedState) {
    return badRequest("invalid state");
  }
  if (oauthError) {
    const parked = cookies.get(POST_LOGIN_REDIRECT_COOKIE);
    cookies.delete(POST_LOGIN_REDIRECT_COOKIE, { path: "/" });
    const safe = normalizeCallback({ callbackUrl: parked }, url.origin);
    const params = new URLSearchParams({
      error: oauthError === "access_denied" ? "AccessDenied" : "OAuthCallback",
    });
    if (safe !== "/") params.set("callbackUrl", safe);
    redirect(303, `/auth/signin?${params}`);
  }
  if (!code) return badRequest("invalid state");
  if (!verifier) return badRequest("missing PKCE verifier");

  let tokens: { id_token?: string; refresh_token?: string };
  try {
    tokens = await exchangeCodeForTokens(config, {
      code,
      codeVerifier: verifier,
      redirectUri: `${config.appOrigin}/auth/callback`,
      fetch,
    });
  } catch {
    return badRequest("token exchange failed");
  }
  if (!tokens.id_token) return badRequest("no id_token in response");

  const session = await verifyIdToken(tokens.id_token);
  if (!session) return badRequest("invalid id_token");

  writeSessionCookies(cookies, {
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
    session,
    // Secure over https (prod); not over plain http (local dev on
    // http://localhost) so the browser keeps the session cookies instead of
    // silently dropping them and looping the sign-in.
    secure: url.protocol === "https:",
  });

  // Honor the destination parked by /auth/signin, re-normalized as defense in
  // depth (never trust the cookie raw). A missing/root/unsafe value falls back
  // to the default home.
  const parked = cookies.get(POST_LOGIN_REDIRECT_COOKIE);
  cookies.delete(POST_LOGIN_REDIRECT_COOKIE, { path: "/" });
  const safe = normalizeCallback({ callbackUrl: parked }, url.origin);
  redirect(303, safe === "/" ? DEFAULT_DESTINATION : safe);
};
