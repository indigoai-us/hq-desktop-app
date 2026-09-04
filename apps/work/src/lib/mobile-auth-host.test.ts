import { VAULT_CLIENT_ID, VAULT_HOSTED_UI_DOMAIN } from "@hq/auth";
import { describe, expect, it, vi } from "vitest";

import { MOBILE_REDIRECT_URI, isMobileAuthCallback } from "./mobile-auth";
import {
  MOBILE_REFRESH_TOKEN_KEY,
  mobileAuthConfig,
  mobileTokenProvider,
  webviewStore,
} from "./mobile-auth-host";

/**
 * The Tauri-shaped half of mobile sign-in.
 *
 * A static bundle has no server to ask for Cognito settings, so the phone
 * compiles in the same public vault-client identifiers the desktop app already
 * inlines. Nothing secret is involved: a client id and a hosted-UI domain both
 * appear in the redirect URL of every sign-in.
 */

describe("mobile auth config", () => {
  it("targets the same Cognito app client every other HQ surface uses", () => {
    const config = mobileAuthConfig();
    expect(config.clientId).toBe(VAULT_CLIENT_ID);
    expect(config.hostedUiDomain).toBe(VAULT_HOSTED_UI_DOMAIN);
    expect(config.issuer).toMatch(/^https:\/\/cognito-idp\./);
  });

  it("never carries the E2E test JWKS seam onto a device", () => {
    // resolveTestJwks() is a server-only, env-gated hook. A phone build has no
    // env, and a token verified against a test key is not a real session.
    expect(mobileAuthConfig().testJwks).toBeUndefined();
  });
});

describe("the deep-link callback predicate", () => {
  it("accepts the registered callback", () => {
    expect(isMobileAuthCallback(`${MOBILE_REDIRECT_URI}?code=x&state=y`)).toBe(
      true,
    );
  });

  it.each([
    "hqmobile://elsewhere?code=x",
    "hq-work://app/connect/cognito-callback?code=x",
    "https://example.test/auth?code=x",
    "not a url",
  ])("rejects %s", (url) => {
    // The shell may be handed any link the OS routes to it. Only the auth
    // callback may reach the token exchange.
    expect(isMobileAuthCallback(url)).toBe(false);
  });
});

describe("the webview refresh-token store", () => {
  function fakeStorage(): Storage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null,
      key: (i: number) => [...map.keys()][i] ?? null,
      removeItem: (k: string) => void map.delete(k),
      setItem: (k: string, v: string) => void map.set(k, v),
    } as Storage;
  }

  it("round-trips the refresh token under one known key", async () => {
    const storage = fakeStorage();
    const store = webviewStore(storage);
    expect(await store.read()).toBeNull();

    await store.write("REFRESH-1");
    expect(storage.getItem(MOBILE_REFRESH_TOKEN_KEY)).toBe("REFRESH-1");
    expect(await store.read()).toBe("REFRESH-1");

    await store.clear();
    expect(await store.read()).toBeNull();
    expect(storage.getItem(MOBILE_REFRESH_TOKEN_KEY)).toBeNull();
  });

  it("degrades to a signed-out session when there is no storage at all", async () => {
    // Server-side render, or a webview with storage disabled. Throwing here
    // would take down the whole shell over a missing convenience.
    const store = webviewStore(null);
    expect(await store.read()).toBeNull();
    await expect(store.write("REFRESH-1")).resolves.toBeUndefined();
    expect(await store.read()).toBeNull();
  });
});

describe("the hq-pro token provider", () => {
  it("hands hq-pro the session's id token", async () => {
    const clear = vi.fn(async () => {});
    const provider = mobileTokenProvider({
      getToken: async () => "ID-1",
      clear,
    });
    expect(await provider.getToken()).toBe("ID-1");
  });

  it("forgets the session when hq-pro rejects the token", async () => {
    // createHqProFetch() calls clear() synchronously on a 401. The session's
    // own clear() is async, so the adapter must not require it to be awaited.
    const clear = vi.fn(async () => {});
    const provider = mobileTokenProvider({
      getToken: async () => "ID-1",
      clear,
    });
    provider.clear();
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
