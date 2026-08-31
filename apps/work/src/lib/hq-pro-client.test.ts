import { describe, expect, it, vi } from "vitest";

import {
  createBrowserTokenProvider,
  createHqProFetch,
  hqProApiUrl,
  type BrowserTokenProvider,
} from "./hq-pro-client.js";

function tokenProvider(value: string | null): BrowserTokenProvider {
  return {
    getToken: async () => value,
    clear: vi.fn(),
  };
}

describe("direct hq-pro browser transport", () => {
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

  it("re-enters the existing sign-in flow when hq-pro returns 401", async () => {
    const onUnauthorized = vi.fn();
    const provider = tokenProvider("expired-token");
    const direct = createHqProFetch({
      baseUrl: "https://hqapi.example.test",
      fetchImpl: async () => new Response("expired", { status: 401 }),
      tokenProvider: provider,
      onUnauthorized,
    });

    const response = await direct("/v1/realtime/credentials", {
      method: "POST",
    });
    expect(response.status).toBe(401);
    expect(provider.clear).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
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
