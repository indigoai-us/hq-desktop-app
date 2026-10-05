import { describe, expect, it, vi } from "vitest";

import { TauriPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

describe("Tauri platform Lambda invoke retry", () => {
  it("retries one exact request-id-free 504 for GET and returns success", async () => {
    let requests = 0;
    const adapter = new TauriPlatformAdapter({
      invoke: vi.fn(async (command: string) => {
        if (command !== "hq_pro_fetch") throw new Error(`unexpected command ${command}`);
        requests += 1;
        return requests === 1
          ? { status: 504, body: '{"message":"Internal server error"}' }
          : { status: 200, body: '{"displayName":"A"}' };
      }),
    });

    await expect(adapter.identity.getProfile()).resolves.toMatchObject({
      ok: true,
      value: { displayName: "A" },
    });
    expect(requests).toBe(2);
  });

  it("stops after the second 504", async () => {
    let requests = 0;
    const adapter = new TauriPlatformAdapter({
      invoke: vi.fn(async (command: string) => {
        if (command !== "hq_pro_fetch") throw new Error(`unexpected command ${command}`);
        requests += 1;
        return { status: 504, body: '{"message":"Internal server error"}' };
      }),
    });

    await expect(adapter.identity.getProfile()).resolves.toMatchObject({ ok: false });
    expect(requests).toBe(2);
  });
});

describe("Sync adapter Lambda invoke retry", () => {
  function makeSyncAdapter(responses: Array<{ status: number; body: string }>) {
    let requests = 0;
    const slept: number[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: vi.fn(async (command: string) => {
        if (command !== "hq_pro_fetch") throw new Error(`unexpected command ${command}`);
        const response = responses[Math.min(requests, responses.length - 1)]!;
        requests += 1;
        return response;
      }),
      requestPolicy: {
        throttle: null,
        sleep: async (ms: number) => {
          slept.push(ms);
        },
      },
    });
    return { adapter, requests: () => requests, slept };
  }

  const GATEWAY_504 = { status: 504, body: '{"message":"Internal server error"}' };

  it("retries one 504 for a GET whose failure keeps its HTTP status (review A-I17)", async () => {
    // The catalog read goes through the status-keeping request helper. It
    // used to skip the single repeat every other GET gets.
    const { adapter, requests, slept } = makeSyncAdapter([
      GATEWAY_504,
      { status: 200, body: '{"entries":[]}' },
    ]);

    await expect(adapter.integrations!.catalogSearch("cmp_acme", "linear")).resolves.toMatchObject({
      ok: true,
      value: { entries: [] },
    });
    expect(requests()).toBe(2);
    expect(slept).toHaveLength(1);
  });

  it("stops after the second 504 and still reports the status", async () => {
    const { adapter, requests } = makeSyncAdapter([GATEWAY_504]);

    await expect(adapter.integrations!.catalogSearch("cmp_acme", "linear")).resolves.toMatchObject({
      ok: false,
      status: 504,
    });
    expect(requests()).toBe(2);
  });

  it("never repeats a POST that met a 504", async () => {
    const { adapter, requests } = makeSyncAdapter([GATEWAY_504]);

    await expect(adapter.agents.attachSlack!("agt_nova")).resolves.toMatchObject({ ok: false, status: 504 });
    expect(requests()).toBe(1);
  });
});
