import { describe, expect, it, vi } from "vitest";

import {
  MOBILE_REDIRECT_URI,
  createMobileAuthSession,
  type MobileAuthStore,
} from "./mobile-auth";

/**
 * Mobile sign-in.
 *
 * A phone has no same-origin session to read a token out of, so it runs the
 * authorization-code + PKCE flow itself against the same Cognito app client
 * every other surface uses. `hqmobile://auth` is already a registered callback
 * URL on that client, which is why the redirect is a custom scheme rather than
 * a loopback port.
 *
 * Everything here is injected — the browser opener, `fetch`, the token store,
 * the clock — so the flow is exercised without a device.
 */

const CONFIG = {
  clientId: "test-client",
  hostedUiDomain: "vault.auth.us-east-1.amazoncognito.com",
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/pool",
  appOrigin: "https://work.example.test",
};

/** A store whose contents the test can read directly, to assert what is at rest. */
type MemoryStore = MobileAuthStore & { value: string | null };

function memoryStore(): MemoryStore {
  const store = {
    value: null as string | null,
    async read() {
      return store.value;
    },
    async write(refreshToken: string) {
      store.value = refreshToken;
    },
    async clear() {
      store.value = null;
    },
  };
  return store;
}

function tokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function setup(
  overrides: {
    fetch?: typeof globalThis.fetch;
    store?: MemoryStore;
    now?: () => number;
  } = {},
) {
  const opened: string[] = [];
  const store = overrides.store ?? memoryStore();
  const session = createMobileAuthSession({
    config: CONFIG,
    fetch:
      overrides.fetch ??
      (vi.fn(async () =>
        tokenResponse({
          id_token: "ID-1",
          refresh_token: "REFRESH-1",
          expires_in: 3600,
        }),
      ) as unknown as typeof globalThis.fetch),
    openUrl: async (url) => {
      opened.push(url);
    },
    store,
    now: overrides.now,
  });
  return { session, opened, store };
}

/** Pull the callback URL a real Cognito redirect would deliver. */
function callbackFor(authorizeUrl: string, code = "CODE-1"): string {
  const state = new URL(authorizeUrl).searchParams.get("state");
  return `${MOBILE_REDIRECT_URI}?code=${code}&state=${state}`;
}

describe("mobile sign-in: starting the flow", () => {
  it("opens the hosted UI with PKCE and the registered mobile callback", async () => {
    const { session, opened } = setup();
    await session.beginSignIn();

    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]);
    expect(url.host).toBe(CONFIG.hostedUiDomain);
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    // Cognito rejects an unregistered redirect outright; this exact string is
    // in the vault-client's callbackUrls.
    expect(url.searchParams.get("redirect_uri")).toBe(MOBILE_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("never puts the verifier itself on the wire", async () => {
    // The whole point of PKCE: the challenge travels, the verifier does not.
    const { session, opened } = setup();
    await session.beginSignIn();
    const url = new URL(opened[0]);
    expect(url.searchParams.get("code_verifier")).toBeNull();
    expect(opened[0]).not.toContain("verifier");
  });

  it("passes a chosen identity provider through so the chooser is skipped", async () => {
    const { session, opened } = setup();
    await session.beginSignIn({ identityProvider: "Google" });
    expect(new URL(opened[0]).searchParams.get("identity_provider")).toBe(
      "Google",
    );
  });

  it("uses fresh PKCE material on every attempt", async () => {
    const { session, opened } = setup();
    await session.beginSignIn();
    await session.beginSignIn();
    const first = new URL(opened[0]).searchParams;
    const second = new URL(opened[1]).searchParams;
    expect(second.get("state")).not.toBe(first.get("state"));
    expect(second.get("code_challenge")).not.toBe(first.get("code_challenge"));
  });
});

describe("mobile sign-in: completing the flow", () => {
  it("exchanges the code and keeps the session usable", async () => {
    // Typed parameters, so the assertions below can read the request body
    // that was actually sent to the token endpoint.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      tokenResponse({
        id_token: "ID-1",
        refresh_token: "REFRESH-1",
        expires_in: 3600,
      }),
    );
    const { session, opened, store } = setup({
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    await session.beginSignIn();
    await session.completeSignIn(callbackFor(opened[0]));

    expect(await session.getToken()).toBe("ID-1");
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("CODE-1");
    expect(body.get("redirect_uri")).toBe(MOBILE_REDIRECT_URI);
    expect(body.get("code_verifier")).toBeTruthy();
    expect(store.value).toBe("REFRESH-1");
  });

  it("persists only the refresh token, never the id token", async () => {
    // The id token is the bearer for every hq-pro call. Keeping it in app
    // storage widens what a device compromise yields for no benefit — it is
    // re-mintable from the refresh token in one request.
    const { session, opened, store } = setup();
    await session.beginSignIn();
    await session.completeSignIn(callbackFor(opened[0]));
    expect(store.value).toBe("REFRESH-1");
    expect(JSON.stringify(store.value)).not.toContain("ID-1");
  });

  it("rejects a callback whose state does not match", async () => {
    const { session } = setup();
    await session.beginSignIn();
    await expect(
      session.completeSignIn(`${MOBILE_REDIRECT_URI}?code=C&state=forged`),
    ).rejects.toThrow(/state/i);
    expect(await session.getToken()).toBeNull();
  });

  it("rejects a replayed callback", async () => {
    // The verifier and state are single-use. A deep link can be delivered more
    // than once, and an old one must not mint a second session.
    const { session, opened } = setup();
    await session.beginSignIn();
    const callback = callbackFor(opened[0]);
    await session.completeSignIn(callback);
    await expect(session.completeSignIn(callback)).rejects.toThrow();
  });

  it("surfaces an error the hosted UI reports instead of hanging", async () => {
    const { session, opened } = setup();
    await session.beginSignIn();
    const state = new URL(opened[0]).searchParams.get("state");
    await expect(
      session.completeSignIn(
        `${MOBILE_REDIRECT_URI}?error=access_denied&state=${state}`,
      ),
    ).rejects.toThrow(/access_denied/);
  });

  it("ignores a deep link that is not the auth callback", async () => {
    const { session } = setup();
    await expect(
      session.completeSignIn("hqmobile://something-else?code=C"),
    ).rejects.toThrow();
  });
});

describe("mobile sign-in: staying signed in", () => {
  it("reports no token before anyone has signed in", async () => {
    const { session } = setup();
    expect(await session.getToken()).toBeNull();
  });

  it("refreshes an expired id token without a second trip to the browser", async () => {
    let clock = 1_000_000;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        tokenResponse({
          id_token: "ID-1",
          refresh_token: "REFRESH-1",
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(
        tokenResponse({ id_token: "ID-2", expires_in: 3600 }),
      );
    const { session, opened } = setup({
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      now: () => clock,
    });
    await session.beginSignIn();
    await session.completeSignIn(callbackFor(opened[0]));
    expect(await session.getToken()).toBe("ID-1");

    clock += 3_700_000;
    expect(await session.getToken()).toBe("ID-2");
    const body = fetchMock.mock.calls[1]?.[1]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("REFRESH-1");
    expect(opened).toHaveLength(1);
  });

  it("restores a session from the stored refresh token on next launch", async () => {
    const store = memoryStore();
    store.value = "REFRESH-STORED";
    const fetchMock = vi.fn(async () =>
      tokenResponse({ id_token: "ID-RESTORED", expires_in: 3600 }),
    );
    const { session } = setup({
      store,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    expect(await session.restore()).toBe(true);
    expect(await session.getToken()).toBe("ID-RESTORED");
  });

  it("forgets a refresh token the pool has rejected", async () => {
    // A revoked or expired refresh token would otherwise be retried on every
    // request for the life of the install.
    const store = memoryStore();
    store.value = "REFRESH-DEAD";
    const { session } = setup({
      store,
      fetch: (async () =>
        new Response("nope", { status: 400 })) as unknown as typeof globalThis.fetch,
    });
    expect(await session.restore()).toBe(false);
    expect(store.value).toBeNull();
    expect(await session.getToken()).toBeNull();
  });

  it("clears everything on sign-out", async () => {
    const { session, opened, store } = setup();
    await session.beginSignIn();
    await session.completeSignIn(callbackFor(opened[0]));
    await session.clear();
    expect(await session.getToken()).toBeNull();
    expect(store.value).toBeNull();
  });
});
