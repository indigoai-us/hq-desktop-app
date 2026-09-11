/**
 * The Tauri-shaped half of mobile sign-in.
 *
 * `mobile-auth.ts` owns the protocol and is fully injectable; this module is
 * the only place that knows the phone's actual browser, storage and deep-link
 * plumbing. The Tauri plugin imports are dynamic on purpose: the same module
 * graph is bundled for the web, where those packages have no host to talk to.
 */

import {
  VAULT_CLIENT_ID,
  VAULT_HOSTED_UI_DOMAIN,
  vaultIssuer,
  type AuthConfig,
} from "@hq/auth";

import type { BrowserTokenProvider } from "./hq-pro-client";
import {
  MOBILE_REDIRECT_URI,
  createMobileAuthSession,
  isMobileAuthCallback,
  type MobileAuthSession,
  type MobileAuthStore,
} from "./mobile-auth";

/** One key, so a sign-out cannot leave a second copy behind under another. */
export const MOBILE_REFRESH_TOKEN_KEY = "hq.work.mobile.refresh-token";

/**
 * Cognito settings for a build with no server behind it.
 *
 * The desktop app already inlines this same set, for the same reason. Both
 * values are public: they are visible in the query string of every hosted-UI
 * redirect. `testJwks` is deliberately absent — it is a server-only, env-gated
 * E2E seam, and a token verified against a test key is not a real session.
 */
export function mobileAuthConfig(): AuthConfig {
  return {
    clientId: VAULT_CLIENT_ID,
    hostedUiDomain: VAULT_HOSTED_UI_DOMAIN,
    issuer: vaultIssuer(),
    // Unused by the authorize/exchange/refresh calls the phone makes: it
    // supplies its own registered redirect instead of deriving one.
    appOrigin: MOBILE_REDIRECT_URI,
  };
}

/**
 * Refresh-token storage in the webview's own origin storage.
 *
 * That storage lives inside the app sandbox on both platforms, so it is not
 * readable by other apps — but it is not the Keychain/Keystore either. It
 * holds ONLY the refresh token (see `MobileAuthStore`), and the store is an
 * injected interface precisely so it can be moved behind a native secure-
 * storage command later without touching the flow.
 */
export function webviewStore(
  storage: Storage | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
): MobileAuthStore {
  return {
    async read() {
      // A webview with storage disabled throws on access rather than
      // returning null. Signed-out is the right answer; a crash is not.
      try {
        return storage?.getItem(MOBILE_REFRESH_TOKEN_KEY) ?? null;
      } catch {
        return null;
      }
    },
    async write(refreshToken: string) {
      try {
        storage?.setItem(MOBILE_REFRESH_TOKEN_KEY, refreshToken);
      } catch {
        /* Sign-in still works for this launch; it just will not survive one. */
      }
    },
    async clear() {
      try {
        storage?.removeItem(MOBILE_REFRESH_TOKEN_KEY);
      } catch {
        /* Nothing to do — the token is already unreachable. */
      }
    },
  };
}

/** Adapt the mobile session to the token seam `createHqProFetch` expects. */
export function mobileTokenProvider(
  session: Pick<MobileAuthSession, "getToken" | "clear">,
): BrowserTokenProvider {
  return {
    getToken: () => session.getToken(),
    // hq-pro's 401 path calls this synchronously and does not await it.
    clear: () => void session.clear(),
  };
}

/** Open the hosted UI in the system browser, outside the app's webview. */
async function openInSystemBrowser(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/**
 * Deliver `hqmobile://auth?…` callbacks to `handler`.
 *
 * `getCurrent()` covers the cold start: iOS and Android can launch a
 * terminated app straight into the callback URL, in which case the listener
 * registered a moment later would never fire.
 */
export async function listenForAuthCallback(
  handler: (url: string) => void,
): Promise<() => void> {
  const { getCurrent, onOpenUrl } = await import(
    "@tauri-apps/plugin-deep-link"
  );
  for (const url of (await getCurrent()) ?? []) {
    if (isMobileAuthCallback(url)) handler(url);
  }
  return await onOpenUrl((urls) => {
    for (const url of urls) if (isMobileAuthCallback(url)) handler(url);
  });
}

/** The session a phone actually runs, with every platform seam filled in. */
export function createTauriMobileAuthSession(): MobileAuthSession {
  return createMobileAuthSession({
    config: mobileAuthConfig(),
    fetch: globalThis.fetch.bind(globalThis),
    openUrl: openInSystemBrowser,
    store: webviewStore(),
  });
}
