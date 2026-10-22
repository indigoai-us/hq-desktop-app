import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./index.js";

function makeAdapter() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      path: String(input).replace("https://api.test", ""),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ avatarUrl: "https://x/a.jpg" }), { status: 200 });
  };
  return { adapter: new WebPlatformAdapter({ baseUrl: "https://api.test", fetch: fetchMock }), calls };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x41]);

describe("WebPlatformAdapter creator avatar upload", () => {
  it("posts the cropped photo as { contentType, data } with base64 bytes", async () => {
    const { adapter, calls } = makeAdapter();
    const res = await adapter.marketplace.uploadCreatorAvatar(JPEG);
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      { method: "POST", path: "/v1/creators/me/avatar", body: { contentType: "image/jpeg", data: "/9j/4EE=" } },
    ]);
  });

  it("refuses bytes that are not an accepted image without calling the server", async () => {
    const { adapter, calls } = makeAdapter();
    const res = await adapter.marketplace.uploadCreatorAvatar(new Uint8Array([1, 2, 3, 4]));
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("refuses an image over 2 MiB without calling the server", async () => {
    const { adapter, calls } = makeAdapter();
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(JPEG);
    const res = await adapter.marketplace.uploadCreatorAvatar(big);
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
