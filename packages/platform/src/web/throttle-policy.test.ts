/**
 * The shared 429/503 policy as the web adapter actually applies it (R2).
 *
 * These go through a real `WebPlatformAdapter` method rather than the policy
 * helpers directly, so they fail if the wiring is removed even while
 * `request-policy.ts` keeps passing its own unit tests.
 */
import { describe, expect, it, vi } from "vitest";

import { WebPlatformAdapter } from "./index.js";

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const map = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    text: async () => (body == null ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

function adapterWith(
  responses: Response[],
  slept: number[],
): { adapter: WebPlatformAdapter; fetchFn: ReturnType<typeof vi.fn> } {
  let index = 0;
  const fetchFn = vi.fn(async () => responses[Math.min(index++, responses.length - 1)]!);
  const adapter = new WebPlatformAdapter({
    baseUrl: "https://api.test",
    fetch: fetchFn as unknown as typeof globalThis.fetch,
    onUnauthorized: () => {},
    requestPolicy: {
      throttle: null,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    },
  });
  return { adapter, fetchFn };
}

describe("WebPlatformAdapter throttle policy", () => {
  it("waits out Retry-After on a 429 and then returns the successful body", async () => {
    const slept: number[] = [];
    const { adapter, fetchFn } = adapterWith(
      [
        response(429, { error: "Too many requests" }, { "retry-after": "2" }),
        response(200, { personUid: "prs_1", email: "a@b.c" }),
      ],
      slept,
    );

    const result = await adapter.identity.whoami();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([2_000]);
    expect(result.ok).toBe(true);
  });

  it("backs off with jitter when the 429 carries no Retry-After", async () => {
    const slept: number[] = [];
    const { adapter, fetchFn } = adapterWith(
      [response(429, { error: "Too many requests" }), response(200, { ok: true })],
      slept,
    );

    await adapter.identity.whoami();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThanOrEqual(0);
    expect(slept[0]).toBeLessThan(1_000);
  });

  it("surfaces the throttle as the failure callers already handle", async () => {
    const slept: number[] = [];
    const { adapter } = adapterWith([response(429, { error: "Slow down" })], slept);

    const result = await adapter.identity.whoami();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("http-429");
      expect(result.message).toBe("Slow down");
    }
  });

  it("does not retry an ordinary server error", async () => {
    const slept: number[] = [];
    const { adapter, fetchFn } = adapterWith(
      [response(500, { error: "boom" })],
      slept,
    );

    const result = await adapter.identity.whoami();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it("does not retry a 401 — the unauthorized hook still fires once", async () => {
    const onUnauthorized = vi.fn();
    const fetchFn = vi.fn(async () => response(401, { error: "nope" }));
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchFn as unknown as typeof globalThis.fetch,
      onUnauthorized,
      requestPolicy: { throttle: null },
    });

    await adapter.identity.whoami();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
