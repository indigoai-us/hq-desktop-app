/**
 * US-002 story acceptance tests (from PRD e2eTests):
 *
 * 1. Given a valid channel rootEventId the caller can read, when
 *    fetchReplyThread is called, then the result has root.eventId, replies[],
 *    and replyCount.
 * 2. Given scope=dm without withPersonUid, when fetchReplyThread is called,
 *    then the host surfaces a 400 and does not hit a wrong partition.
 * 3. Given sendReply on a project channel, when the POST returns 200, then
 *    the body included rootEventId and the main send-without-root path is
 *    untouched.
 *
 * Follows the US-007 story-test convention: vitest drives the real
 * WebPlatformAdapter + createConversationApi with a mocked fetch. No live
 * Cognito. GET /v1/notify/threads (plural) is this feature — not
 * GET /v1/notify/thread (1:1 conversation).
 */

import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "@hq/platform";

import { createConversationApi } from "../../src/lib/chat-adapter.js";

interface RecordedHttp {
  method: string;
  path: string;
  body: unknown;
}

function makeApi(handler: (call: RecordedHttp) => Response) {
  const calls: RecordedHttp[] = [];
  const adapter = new WebPlatformAdapter({
    baseUrl: "https://api.test",
    fetch: async (input, init) => {
      const call: RecordedHttp = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: String(input).replace("https://api.test", ""),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return handler(call);
    },
  });
  return { api: createConversationApi(adapter), calls };
}

describe("US-002: Adapter + ConversationApi for fetchReplyThread / sendReply", () => {
  it("Given a valid channel rootEventId the caller can read, when fetchReplyThread is called, then the result has root.eventId, replies[], and replyCount", async () => {
    const { api, calls } = makeApi((call) => {
      if (call.path.startsWith("/v1/notify/threads")) {
        return new Response(
          JSON.stringify({
            scope: "channel",
            root: {
              eventId: "evt_root",
              body: "root body",
              createdAt: "2026-08-17T01:00:00.000Z",
              replyCount: 2,
            },
            replies: [
              {
                eventId: "evt_r1",
                rootEventId: "evt_root",
                body: "first",
                createdAt: "2026-08-17T01:01:00.000Z",
              },
              {
                eventId: "evt_r2",
                rootEventId: "evt_root",
                body: "second",
                createdAt: "2026-08-17T01:02:00.000Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const result = await api.fetchReplyThread({
      scope: "channel",
      rootEventId: "evt_root",
      channelId: "chn_general",
    });

    expect(result.root?.eventId).toBe("evt_root");
    expect(Array.isArray(result.replies)).toBe(true);
    expect(result.replies).toHaveLength(2);
    expect(result.replyCount).toBe(2);
    expect(calls).toEqual([
      {
        method: "GET",
        path: "/v1/notify/threads?scope=channel&rootEventId=evt_root&channelId=chn_general",
        body: undefined,
      },
    ]);
    expect(calls[0]?.path.includes("/v1/notify/thread?")).toBe(false);
  });

  it("Given scope=dm without withPersonUid, when fetchReplyThread is called, then the host surfaces a 400 and does not hit a wrong partition", async () => {
    const { api, calls } = makeApi(() => {
      throw new Error("fetch must not run for a missing DM partition key");
    });

    await expect(
      api.fetchReplyThread({
        scope: "dm",
        rootEventId: "evt_root",
      }),
    ).rejects.toThrow(/\[http-400\].*withPersonUid/);

    expect(calls).toEqual([]);
  });

  it("Given sendReply on a project channel, when the POST returns 200, then the body included rootEventId and the main send-without-root path is untouched", async () => {
    const { api, calls } = makeApi((call) => {
      if (call.method === "POST") {
        return new Response(JSON.stringify({ eventId: "evt_new" }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    });

    await api.sendReply({
      scope: "channel",
      rootEventId: "evt_root",
      channelId: "chn_proj",
      body: "ok",
    });
    await api.sendChannelMessage({
      channelId: "chn_proj",
      body: "top-level",
    });

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/v1/notify/channels/chn_proj/messages",
      body: { body: "ok", rootEventId: "evt_root" },
    });
    expect(calls[1]).toEqual({
      method: "POST",
      path: "/v1/notify/channels/chn_proj/messages",
      body: { body: "top-level" },
    });
    expect(
      calls.some((call) => call.path.startsWith("/v1/notify/threads")),
    ).toBe(false);
  });
});
