import { describe, expect, it, vi } from "vitest";

import { failure, ok, WebPlatformAdapter, type PlatformAdapter } from "@hq/platform";

import { createChatSidebarApi } from "./chat-adapter.js";

vi.mock("./hq-pro-client.js", () => ({ hqProFetch: vi.fn() }));

const REQUEST = {
  pairKey: "pk_ada",
  fromPersonUid: "prs_ada",
  fromEmail: "ada@example.com",
  fromDisplayName: "Ada",
  createdAt: "2026-09-10T00:00:00.000Z",
};

function stub(messaging: Record<string, unknown>): PlatformAdapter {
  return { messaging } as unknown as PlatformAdapter;
}

describe("createChatSidebarApi DM connection requests", () => {
  it("wraps the adapter's bare request array exactly once", async () => {
    const api = createChatSidebarApi(
      stub({ listDmRequests: async () => ok([REQUEST]) }),
    );
    await expect(api.listDmRequests()).resolves.toEqual({ requests: [REQUEST] });
  });

  it("yields a real array for the web adapter's `{ requests }` envelope (no double wrap)", async () => {
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async () =>
        new Response(JSON.stringify({ requests: [REQUEST] }), { status: 200 }),
    });
    const api = createChatSidebarApi(adapter);
    const resp = await api.listDmRequests();
    expect(Array.isArray(resp.requests)).toBe(true);
    expect(resp.requests).toEqual([REQUEST]);
  });

  it("forwards respondDmRequest and throws on adapter failure", async () => {
    const respondDmRequest = vi
      .fn()
      .mockResolvedValueOnce(ok({ state: "accepted" }))
      .mockResolvedValueOnce(failure("http-409", "already resolved"));
    const api = createChatSidebarApi(stub({ respondDmRequest }));
    expect(api.respondDmRequest).toBeTypeOf("function");
    await expect(
      api.respondDmRequest!({ pairKey: "pk_ada", action: "accept" }),
    ).resolves.toBeUndefined();
    await expect(
      api.respondDmRequest!({ pairKey: "pk_ada", action: "decline" }),
    ).rejects.toThrow(/already resolved/);
    expect(respondDmRequest).toHaveBeenNthCalledWith(1, {
      pairKey: "pk_ada",
      action: "accept",
    });
  });

  it("omits respondDmRequest when the platform adapter lacks the seam", () => {
    const api = createChatSidebarApi(stub({}));
    expect(api.respondDmRequest).toBeUndefined();
  });
});
