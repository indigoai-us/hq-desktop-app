/**
 * GET /auth/signin — branded sign-in.
 *
 * Two modes, decided server-side in `load`:
 *
 * 1. Deep-link (`?idp=<Provider>`): start the authorization-code + PKCE flow
 *    and jump STRAIGHT to the chosen IdP. We append `identity_provider=<idp>`
 *    to Cognito's /oauth2/authorize so Cognito skips its generic hosted
 *    chooser. PKCE verifier + CSRF state are parked in short-lived httpOnly
 *    cookies; the safe post-login destination rides its own cookie.
 *
 * 2. No idp: render the branded card (+page.svelte) with a live button per
 *    enabled provider. We never auto-redirect to Cognito's hosted chooser —
 *    the branded page IS the chooser.
 *
 * When the Hosted UI is not configured (local dev without env), the page still
 * renders but its provider buttons are disabled (a live deep-link would hit a
 * broken redirect).
 */

import { buildAuthorizeUrl } from "@hq/auth";
import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

import { normalizeCallback, searchParamsToSignIn } from "$lib/auth/callback";
import {
  SIGNIN_PROVIDERS,
  SIGNIN_PROVIDER_CONFIG,
  isEnabledSignInProvider,
} from "$lib/auth/signin-providers";
import {
  OAUTH_STATE_COOKIE,
  PKCE_VERIFIER_COOKIE,
  POST_LOGIN_REDIRECT_COOKIE,
  authConfig,
  isSigninConfigured,
  pkceChallenge,
  randomToken,
} from "$lib/server/auth";

/**
 * Options for the short-lived PKCE-verifier / CSRF-state / return-to cookies.
 *
 * `secure` is conditional on the request protocol: https (prod) → Secure, but
 * plain http (local dev on http://localhost) → not Secure, so the browser does
 * not silently drop the cookie and break the round-trip. httpOnly + sameSite
 * stay unchanged.
 */
function transientCookie(url: URL) {
  return {
    path: "/",
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "lax" as const,
    maxAge: 600,
  };
}

function errorMessage(error: string | undefined): string | null {
  if (!error) return null;
  if (error === "OAuthCallback")
    return "We could not complete that sign-in. Try again.";
  if (error === "AccessDenied") return "Access was denied for that account.";
  return "Sign-in did not complete. Try again.";
}

export const load: PageServerLoad = async ({ url, cookies }) => {
  const config = authConfig({ origin: url.origin });
  const configured = isSigninConfigured(config);
  const params = searchParamsToSignIn(url.searchParams);
  const callbackUrl = normalizeCallback(params);
  const error = errorMessage(params.error);

  const idp = params.idp ?? params.provider;

  // Deep-link branch: start the flow and jump straight to the IdP.
  if (idp && isEnabledSignInProvider(idp) && configured) {
    const verifier = randomToken();
    const state = randomToken(16);
    const transient = transientCookie(url);
    cookies.set(PKCE_VERIFIER_COOKIE, verifier, transient);
    cookies.set(OAUTH_STATE_COOKIE, state, transient);
    // Carry the post-login destination across the round-trip. "/" means "no
    // explicit destination" — the callback defaults it to the shell at "/" —
    // so we only bother persisting a real, non-root path.
    if (callbackUrl !== "/") {
      cookies.set(POST_LOGIN_REDIRECT_COOKIE, callbackUrl, transient);
    } else {
      cookies.delete(POST_LOGIN_REDIRECT_COOKIE, { path: "/" });
    }

    const authorizeUrl = buildAuthorizeUrl(config, {
      redirectUri: `${config.appOrigin}/auth/callback`,
      state,
      codeChallenge: await pkceChallenge(verifier),
      identityProvider: SIGNIN_PROVIDER_CONFIG[idp].identityProvider,
    });
    redirect(302, authorizeUrl);
  }

  // Render branch: the branded chooser.
  return {
    error,
    callbackUrl,
    configured,
    providers: SIGNIN_PROVIDERS.map((id) => ({
      id,
      label: SIGNIN_PROVIDER_CONFIG[id].label,
      enabled: SIGNIN_PROVIDER_CONFIG[id].enabled,
    })),
  };
};
