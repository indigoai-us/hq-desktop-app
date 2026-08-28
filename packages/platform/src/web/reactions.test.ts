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
    if (path.split("?")[0] === "/v1/notify/reactions") {
      if (method === "GET") {
        return new Response(
          JSON.stringify({
            reactions: [{ emoji: "👍", count: 1, reactedByMe: true }],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    adapter: new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    }),
    calls,
  };
}

describe("WebPlatformAdapter reactions", () => {
  it("GETs aggregates and POSTs/DELETEs the toggle body", async () => {
    const { adapter, calls } = makeAdapter();

    const got = await adapter.messaging.fetchReactions("dm:prs_jacob", "evt_1");
    expect(got.ok && got.value).toEqual({
      reactions: [{ emoji: "👍", count: 1, reactedByMe: true }],
    });
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/v1/notify/reactions?messageScope=dm%3Aprs_jacob&messageId=evt_1",
    });

    const add = await adapter.messaging.toggleReaction({
      messageScope: "dm:prs_jacob",
      messageId: "evt_1",
      emoji: "🎉",
      add: true,
    });
    expect(add.ok).toBe(true);
    expect(calls[1]).toEqual({
      method: "POST",
      path: "/v1/notify/reactions",
      body: {
        messageScope: "dm:prs_jacob",
        messageId: "evt_1",
        emoji: "🎉",
      },
    });

    const remove = await adapter.messaging.toggleReaction({
      messageScope: "dm:prs_jacob",
      messageId: "evt_1",
      emoji: "🎉",
      add: false,
    });
    expect(remove.ok).toBe(true);
    expect(calls[2]).toEqual({
      method: "DELETE",
      path: "/v1/notify/reactions",
      body: {
        messageScope: "dm:prs_jacob",
        messageId: "evt_1",
        emoji: "🎉",
      },
    });
  });
});
