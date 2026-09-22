/**
 * The shared 429/503 policy on the Sync host (R2).
 *
 * The desktop path never touches `fetch` — every hq-pro call rides the Rust
 * `hq_pro_fetch` bridge, which now returns `retryAfter` alongside status and
 * body. These tests drive the adapter through that bridge.
 */
import { describe, expect, it, vi } from "vitest";

import { createSyncPlatformAdapter } from "./sync-adapter.js";

function makeAdapter(
  hqProResponses: Array<{ status: number; body: string; retryAfter?: string }>,
  slept: number[],
) {
  let index = 0;
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === "get_auth_state") {
      return { authenticated: true, accountId: "acc", email: "a@b.c" };
    }
    if (cmd === "hq_pro_fetch") {
      return hqProResponses[Math.min(index++, hqProResponses.length - 1)]!;
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  const adapter = createSyncPlatformAdapter({
    invoke,
    fetch: (() => {
      throw new Error("production must not use window.fetch");
    }) as unknown as typeof globalThis.fetch,
    requestPolicy: {
      throttle: null,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    },
  });
  return { adapter, invoke, hqProCalls: () => index };
}

describe("Sync adapter throttle policy", () => {
  it("honours Retry-After on a 429 and then returns the successful body", async () => {
    const slept: number[] = [];
    const { adapter, hqProCalls } = makeAdapter(
      [
        { status: 429, body: '{"error":"Too many requests"}', retryAfter: "2" },
        { status: 200, body: '{"displayName":"A"}' },
      ],
      slept,
    );

    const result = await adapter.identity.getProfile();

    expect(hqProCalls()).toBe(2);
    expect(slept).toEqual([2_000]);
    expect(result.ok).toBe(true);
  });

  it("backs off with jitter when the bridge reports no Retry-After", async () => {
    const slept: number[] = [];
    const { adapter, hqProCalls } = makeAdapter(
      [
        { status: 503, body: "" },
        { status: 200, body: '{"displayName":"A"}' },
      ],
      slept,
    );

    await adapter.identity.getProfile();

    expect(hqProCalls()).toBe(2);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeLessThan(1_000);
  });

  it("surfaces an unrelieved throttle as the http-429 failure, not a crash", async () => {
    const slept: number[] = [];
    const { adapter } = makeAdapter(
      [{ status: 429, body: '{"error":"Slow down"}' }],
      slept,
    );

    const result = await adapter.identity.getProfile();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("http-429");
  });

  it("does not retry a 404 feature-detection miss", async () => {
    const slept: number[] = [];
    const { adapter, hqProCalls } = makeAdapter(
      [{ status: 404, body: '{"error":"not found"}' }],
      slept,
    );

    const result = await adapter.identity.getProfile();

    expect(hqProCalls()).toBe(1);
    expect(slept).toEqual([]);
    expect(result.ok).toBe(false);
  });
});
