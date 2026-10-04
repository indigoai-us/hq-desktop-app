import { describe, expect, it, vi } from "vitest";

import { TauriPlatformAdapter } from "./index.js";

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
