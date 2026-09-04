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

describe("WebPlatformAdapter hasFeature", () => {
  it("meetings: snapshot missing → deliberate false, never the 404 identity/features path", async () => {
    const { adapter, calls } = makeAdapter({});
    const result = await adapter.identity.hasFeature("meetings");
    expect(result).toEqual({ ok: true, value: false });
    expect(calls.some((c) => c.path.includes("/v1/identity/features/"))).toBe(
      false,
    );
    expect(
      calls.some((c) => c.path.startsWith("/v1/flags/resolve")),
    ).toBe(true);
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
    expect(calls.some((c) => c.path.includes("/v1/identity/features/"))).toBe(
      false,
    );
  });

  it("meetings: snapshot configured true → registry value", async () => {
    const { adapter } = makeAdapter({
      "GET /v1/flags/resolve": {
        status: 200,
        body: { version: 3, flags: { "desktop.meetings": true } },
      },
    });
    await expect(adapter.identity.hasFeature("meetings")).resolves.toEqual({
      ok: true,
      value: true,
    });
  });

  it("meetings: snapshot configured false → registry value", async () => {
    const { adapter } = makeAdapter({
      "GET /v1/flags/resolve": {
        status: 200,
        body: { version: 3, flags: { "desktop.meetings": false } },
      },
    });
    await expect(adapter.identity.hasFeature("meetings")).resolves.toEqual({
      ok: true,
      value: false,
    });
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
});
