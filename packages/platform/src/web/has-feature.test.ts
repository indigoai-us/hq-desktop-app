import { describe, expect, it } from "vitest";
import { WebPlatformAdapter } from "./index.js";

interface RecordedCall {
  method: string;
  path: string;
}

function makeAdapter(routes: Record<string, { status: number; body: unknown }>) {
  const calls: RecordedCall[] = [];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const path = url.replace("https://api.test", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path });
    const key = `${method} ${path.split("?")[0]}`;
    const route = routes[key];
    if (!route) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(route.body), { status: route.status });
  };
  return {
    adapter: new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
      headers: { Authorization: "Bearer test-token" },
    }),
    calls,
  };
}

function calledFlagsResolve(calls: RecordedCall[]): boolean {
  return calls.some((c) => c.path.startsWith("/v1/flags/resolve"));
}

function calledIdentityFeatures(calls: RecordedCall[]): boolean {
  return calls.some((c) => c.path.includes("/v1/identity/features/"));
}

describe("WebPlatformAdapter hasFeature", () => {
  it("meetings: registry configured true still resolves false and never consults the registry", async () => {
    const { adapter, calls } = makeAdapter({
      "GET /v1/flags/resolve": {
        status: 200,
        body: { version: 3, flags: { "desktop.meetings": true } },
      },
    });
    await expect(adapter.identity.hasFeature("meetings")).resolves.toEqual({
      ok: true,
      value: false,
    });
    expect(calledFlagsResolve(calls)).toBe(false);
    expect(calledIdentityFeatures(calls)).toBe(false);
  });

  it("meetings: snapshot missing / registry unreachable → false, no registry or identity/features GET", async () => {
    const { adapter, calls } = makeAdapter({});
    const result = await adapter.identity.hasFeature("meetings");
    expect(result).toEqual({ ok: true, value: false });
    expect(calledIdentityFeatures(calls)).toBe(false);
    expect(calledFlagsResolve(calls)).toBe(false);
  });

  it("meetings: snapshot present-but-unconfigured → deliberate false", async () => {
    const { adapter, calls } = makeAdapter({
      "GET /v1/flags/resolve": {
        status: 200,
        body: { version: 1, flags: {} },
      },
    });
    const result = await adapter.identity.hasFeature("meetings");
    expect(result).toEqual({ ok: true, value: false });
    expect(calledIdentityFeatures(calls)).toBe(false);
    expect(calledFlagsResolve(calls)).toBe(false);
  });

  it("meetings: snapshot configured false still resolves false without consulting the registry", async () => {
    const { adapter, calls } = makeAdapter({
      "GET /v1/flags/resolve": {
        status: 200,
        body: { version: 3, flags: { "desktop.meetings": false } },
      },
    });
    await expect(adapter.identity.hasFeature("meetings")).resolves.toEqual({
      ok: true,
      value: false,
    });
    expect(calledFlagsResolve(calls)).toBe(false);
  });

  it("meetings: registry fetch throw → false, no rejection", async () => {
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async () => {
        throw new Error("network down");
      },
    });
    await expect(adapter.identity.hasFeature("meetings")).resolves.toEqual({
      ok: true,
      value: false,
    });
  });

  it("is_indigo_user stays on the legacy identity/features GET", async () => {
    const { adapter, calls } = makeAdapter({});
    const result = await adapter.identity.hasFeature("is_indigo_user");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("http-404");
    expect(calls).toEqual([
      { method: "GET", path: "/v1/identity/features/is_indigo_user" },
    ]);
  });

  it("unmapped flag stays on the legacy identity/features GET (byte-for-byte)", async () => {
    const { adapter, calls } = makeAdapter({});
    const result = await adapter.identity.hasFeature("some_other_flag");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("http-404");
    expect(calls).toEqual([
      { method: "GET", path: "/v1/identity/features/some_other_flag" },
    ]);
    expect(calledFlagsResolve(calls)).toBe(false);
  });
});
