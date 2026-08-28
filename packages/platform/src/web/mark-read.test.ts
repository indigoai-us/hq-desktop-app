import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./index.js";

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function makeAdapter() {
  const calls: RecordedCall[] = [];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const path = url.replace("https://api.test", "");
    const method = init?.method ?? "GET";
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ method, path, body });
    return new Response(JSON.stringify({ persisted: true }), { status: 200 });
  };
  return {
    adapter: new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    }),
    calls,
  };
}

describe("WebPlatformAdapter mark-read", () => {
  it("POSTs channel lastRead and DM pair lastReadAt", async () => {
    const { adapter, calls } = makeAdapter();

    const channel = await adapter.messaging.markChannelRead("chn_1");
    expect(channel.ok).toBe(true);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/v1/notify/channels/chn_1/read",
      body: {},
    });

    const dm = await adapter.messaging.markDmThreadRead("prs_jacob");
    expect(dm.ok).toBe(true);
    expect(calls[1]).toEqual({
      method: "POST",
      path: "/v1/notify/thread/read",
      body: { withPersonUid: "prs_jacob" },
    });
  });

  it("rejects a blank DM counterpart without calling the API", async () => {
    const { adapter, calls } = makeAdapter();
    const dm = await adapter.messaging.markDmThreadRead("   ");
    expect(dm.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
