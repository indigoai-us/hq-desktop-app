// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBrowserTokenProvider,
  createHqProFetch,
  hqProApiUrl,
  redirectToSigninWithCallback,
  type BrowserTokenProvider,
} from "./hq-pro-client.js";

function tokenProvider(value: string | null): BrowserTokenProvider {
  return {
    getToken: async () => value,
    clear: vi.fn(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("direct hq-pro browser transport", () => {
  it("redirects with the complete callback URL and does not loop on auth routes", () => {
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {});
    window.history.replaceState(
      {},
      "",
      "/?channel=chn_launch&reply=evt_1#thread",
    );

    redirectToSigninWithCallback();

    expect(assign).toHaveBeenCalledWith(
      "/auth/signin?callbackUrl=%2F%3Fchannel%3Dchn_launch%26reply%3Devt_1%23thread",
    );

    window.history.replaceState({}, "", "/auth/signin?callbackUrl=%2F");
    redirectToSigninWithCallback();
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("uses the documented development default only when no public URL is set", () => {
    expect(hqProApiUrl(undefined, true)).toBe("https://hqapi.hq.computer");
    expect(hqProApiUrl(undefined, false)).toBe("");
    expect(hqProApiUrl("https://pro.example.test///", false)).toBe(
      "https://pro.example.test",
    );
  });

  it("reads the token from the authenticated same-origin endpoint once", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ idToken: "id-token" }), { status: 200 }),
    );
    const provider = createBrowserTokenProvider({ fetchImpl });

    await expect(provider.getToken()).resolves.toBe("id-token");
    await expect(provider.getToken()).resolves.toBe("id-token");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/token", {
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it("attaches the Cognito Bearer to direct hq-pro calls", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const direct = createHqProFetch({
      baseUrl: "https://hqapi.example.test",
      fetchImpl,
      tokenProvider: tokenProvider("id-token"),
    });

    await direct("/v1/notify/channels?limit=25");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://hqapi.example.test/v1/notify/channels?limit=25");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer id-token",
    );
    expect(init.credentials).toBe("omit");
  });

  it("redirects only after the one permitted retry also returns 401", async () => {
    const onUnauthorized = vi.fn();
    const provider = tokenProvider("expired-token");
    const fetchImpl = vi.fn(async () => new Response("expired", { status: 401 }));
    const direct = createHqProFetch({
      baseUrl: "https://hqapi.example.test",
      fetchImpl,
      tokenProvider: provider,
      onUnauthorized,
    });

    const response = await direct("/v1/realtime/credentials", {
      method: "POST",
    });
    expect(response.status).toBe(401);
    expect(provider.clear).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expired browser token once and retries the failed request", async () => {
    const onUnauthorized = vi.fn();
    const apiTokens = ["expired-token", "fresh-token"];
    const apiAuthorization: string[] = [];
    let requestAttempts = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === "/api/auth/token") {
        return new Response(JSON.stringify({ idToken: apiTokens.shift() }), {
          status: 200,
        });
      }
      apiAuthorization.push(new Headers(init?.headers).get("authorization") ?? "");
      requestAttempts += 1;
      return new Response(requestAttempts === 1 ? "expired" : "{}", {
        status: requestAttempts === 1 ? 401 : 200,
      });
    });
    const direct = createHqProFetch({
      baseUrl: "https://hqapi.example.test",
      fetchImpl,
      onUnauthorized,
    });

    await expect(direct("/v1/notify/channels")).resolves.toMatchObject({
      status: 200,
    });
    expect(apiAuthorization).toEqual([
      "Bearer expired-token",
      "Bearer fresh-token",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("redirects once when the refresh token cannot mint a replacement", async () => {
    const onUnauthorized = vi.fn();
    let tokenCalls = 0;
    let apiCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/auth/token") {
        tokenCalls += 1;
        return tokenCalls === 1
          ? new Response(JSON.stringify({ idToken: "expired-token" }), {
              status: 200,
            })
          : new Response("", { status: 401 });
      }
      apiCalls += 1;
      return new Response("expired", { status: 401 });
    });
    const direct = createHqProFetch({
      baseUrl: "https://hqapi.example.test",
      fetchImpl,
      onUnauthorized,
    });

    await expect(direct("/v1/notify/channels")).resolves.toMatchObject({
      status: 401,
    });
    expect(tokenCalls).toBe(2);
    expect(apiCalls).toBe(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("re-enters sign-in once when the same-origin token bridge is unauthenticated", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    const direct = createHqProFetch({
      baseUrl: "https://hqapi.example.test",
      fetchImpl,
      onUnauthorized,
    });

    const response = await direct("/v1/identity/whoami");
    expect(response.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not maintain a proxy path allowlist for direct public API routes", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const direct = createHqProFetch({
      baseUrl: "https://hqapi.example.test",
      fetchImpl,
      tokenProvider: tokenProvider("id-token"),
    });

    await direct("/v1/future-api/not-yet-known-to-work");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://hqapi.example.test/v1/future-api/not-yet-known-to-work",
      expect.objectContaining({ credentials: "omit" }),
    );
  });
});
