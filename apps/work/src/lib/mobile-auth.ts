/**
 * Mobile sign-in — the authorization-code + PKCE flow, run by the app itself.
 *
 * The web build reads its bearer out of an authenticated same-origin session
 * (`/api/auth/token`). A phone has no such session and no server, so it talks
 * to Cognito directly using the same `@hq/auth` core every other surface uses.
 *
 * The redirect is a custom scheme rather than a loopback port because
 * `hqmobile://auth` is already a registered callback URL on the vault-client
 * app client — Cognito rejects anything not on that list, so this string is
 * not a free choice.
 *
 * Everything platform-shaped is injected: opening the browser, `fetch`, the
 * token store, and the clock. The flow is therefore testable with no device,
 * and the Tauri-specific wiring stays in `mobile-auth-host.ts`.
 */

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  pkceChallenge,
  randomToken,
  refreshTokens,
  type AuthConfig,
  type TokenResponse,
} from "@hq/auth";

/** Registered on the vault-client Cognito app client. Not a free choice. */
export const MOBILE_REDIRECT_URI = "hqmobile://auth";

/**
 * Refresh this far before the id token actually expires, so a request that is
 * already in flight when the clock crosses over does not 401.
 */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Persistence for the refresh token only.
 *
 * The id token stays in memory: it is the bearer for every hq-pro call, it is
 * re-mintable from the refresh token in one request, and writing it to disk
 * only widens what a device compromise yields.
 */
export interface MobileAuthStore {
  read(): Promise<string | null>;
  write(refreshToken: string): Promise<void>;
  clear(): Promise<void>;
}

export interface MobileAuthDeps {
  config: AuthConfig;
  fetch: typeof globalThis.fetch;
  /** Hand the authorize URL to the system browser. */
  openUrl(url: string): Promise<void>;
  store: MobileAuthStore;
  /** Injected clock, so expiry is testable without waiting an hour. */
  now?: () => number;
}

export interface MobileAuthSession {
  /** Open the hosted UI. Resolves once the browser has been handed the URL. */
  beginSignIn(options?: { identityProvider?: string }): Promise<void>;
  /** Consume the `hqmobile://auth?...` deep link the browser redirects to. */
  completeSignIn(callbackUrl: string): Promise<void>;
  /** Restore a session from the stored refresh token. */
  restore(): Promise<boolean>;
  /** Current id token, refreshing it if needed. `null` means signed out. */
  getToken(): Promise<string | null>;
  /** Sign out: drop the cached token and forget the refresh token. */
  clear(): Promise<void>;
}

/** `hqmobile://auth?code=…` → its query, or null if this is some other link. */
function callbackParams(callbackUrl: string): URLSearchParams | null {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return null;
  }
  const expected = new URL(MOBILE_REDIRECT_URI);
  if (url.protocol !== expected.protocol) return null;
  // A custom-scheme URL puts the "auth" part in the host. Compare the path too
  // so a link to a different in-app destination is not treated as a callback.
  if (url.host !== expected.host) return null;
  if (url.pathname.replace(/\/+$/, "") !== expected.pathname.replace(/\/+$/, "")) {
    return null;
  }
  return url.searchParams;
}

/** Is this OS-delivered link the auth callback, or some other deep link? */
export function isMobileAuthCallback(callbackUrl: string): boolean {
  return callbackParams(callbackUrl) !== null;
}

export function createMobileAuthSession(
  deps: MobileAuthDeps,
): MobileAuthSession {
  const now = deps.now ?? (() => Date.now());

  /** PKCE material for the authorize request currently in flight. */
  let pending: { verifier: string; state: string } | null = null;
  let idToken: string | null = null;
  let idTokenExpiresAt = 0;
  let refreshToken: string | null = null;

  function absorb(tokens: TokenResponse): void {
    if (typeof tokens.id_token === "string" && tokens.id_token) {
      idToken = tokens.id_token;
      const lifetimeSec =
        typeof tokens.expires_in === "number" ? tokens.expires_in : 3600;
      idTokenExpiresAt = now() + lifetimeSec * 1000;
    }
    // A refresh response usually omits refresh_token; keep the one we have
    // rather than dropping the session on a successful refresh.
    if (typeof tokens.refresh_token === "string" && tokens.refresh_token) {
      refreshToken = tokens.refresh_token;
    }
  }

  async function forget(): Promise<void> {
    idToken = null;
    idTokenExpiresAt = 0;
    refreshToken = null;
    await deps.store.clear();
  }

  /** Swap the refresh token for a fresh id token. Returns false if it is dead. */
  async function refreshFrom(token: string): Promise<boolean> {
    try {
      const tokens = await refreshTokens(deps.config, {
        refreshToken: token,
        fetch: deps.fetch,
      });
      if (typeof tokens.id_token !== "string" || !tokens.id_token) return false;
      refreshToken = token;
      absorb(tokens);
      return true;
    } catch {
      return false;
    }
  }

  return {
    async beginSignIn(options = {}) {
      const verifier = randomToken();
      const state = randomToken(16);
      const url = buildAuthorizeUrl(deps.config, {
        redirectUri: MOBILE_REDIRECT_URI,
        state,
        codeChallenge: await pkceChallenge(verifier),
        identityProvider: options.identityProvider,
      });
      // Recorded before the browser opens, so the callback can never arrive
      // ahead of the material needed to verify it.
      pending = { verifier, state };
      await deps.openUrl(url);
    },

    async completeSignIn(callbackUrl) {
      const params = callbackParams(callbackUrl);
      if (!params) {
        throw new Error("not the sign-in callback");
      }
      if (!pending) {
        throw new Error("no sign-in is in progress");
      }
      if (params.get("state") !== pending.state) {
        // Leave `pending` alone: a forged or stale link must not cancel the
        // real sign-in the person is still completing in the browser.
        throw new Error("sign-in state did not match");
      }

      // Single-use from here: whatever happens, this material is spent.
      const { verifier } = pending;
      pending = null;

      const error = params.get("error");
      if (error) {
        throw new Error(
          `sign-in failed: ${error}${
            params.get("error_description")
              ? ` (${params.get("error_description")})`
              : ""
          }`,
        );
      }
      const code = params.get("code");
      if (!code) throw new Error("sign-in callback carried no code");

      const tokens = await exchangeCodeForTokens(deps.config, {
        code,
        codeVerifier: verifier,
        redirectUri: MOBILE_REDIRECT_URI,
        fetch: deps.fetch,
      });
      absorb(tokens);
      if (refreshToken) await deps.store.write(refreshToken);
    },

    async restore() {
      const stored = await deps.store.read();
      if (!stored) return false;
      if (await refreshFrom(stored)) return true;
      // Revoked or expired: forget it, or every request for the life of the
      // install retries a token the pool will never accept.
      await forget();
      return false;
    },

    async getToken() {
      if (idToken && now() < idTokenExpiresAt - EXPIRY_SKEW_MS) return idToken;
      const token = refreshToken ?? (await deps.store.read());
      if (!token) return null;
      if (await refreshFrom(token)) return idToken;
      await forget();
      return null;
    },

    async clear() {
      pending = null;
      await forget();
    },
  };
}
