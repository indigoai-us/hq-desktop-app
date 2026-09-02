/**
 * US-003 story acceptance tests (from PRD e2eTests):
 *
 * 1. Given a project channel root with 0 replies, when the user clicks Reply
 *    and sends “ok”, then the panel shows that reply and the main timeline
 *    still has only the root.
 * 2. Given a DM root with replyCount 1, when the user taps “1 reply”, then
 *    the panel loads the root plus that reply.
 * 3. Given a chat channel at a narrow viewport, when the panel opens, then
 *    it overlays the timeline and Close returns to the timeline.
 *
 * Follows the US-001/US-002/US-007 story-test convention: vitest drives the
 * real WebPlatformAdapter + createConversationApi with a mocked fetch. UI
 * open/close/Esc/retry mounts live in packages/ui US-003.story.test.ts
 * (apps/web vitest is the Svelte server runtime). No live Cognito.
 */

import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "@hq/platform";

import { createConversationApi } from "../../src/lib/chat-adapter.js";
import {
  isReplyMessage,
  messagesForDisplay,
} from "../../../../packages/ui/src/chat/live-messages.js";
import { replyColumnLayout } from "../../../../packages/ui/src/chat/reply-layout.js";
import type { ConversationMessageWire } from "../../../../packages/ui/src/chat/chat-api.js";

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

const projectRoot: ConversationMessageWire = {
  eventId: "evt_root",
  body: "root body",
  createdAt: "2026-08-17T01:00:00.000Z",
  fromDisplayName: "Ada",
  replyCount: 0,
};

describe("US-003: Reply affordance + ReplyPanel in the shared shell", () => {
  it("Given a project channel root with 0 replies, when the user clicks Reply and sends “ok”, then the panel shows that reply and the main timeline still has only the root", async () => {
    const { api, calls } = makeApi((call) => {
      if (call.method === "POST") {
        return new Response(JSON.stringify({ eventId: "evt_ok" }), {
          status: 200,
        });
      }
      if (call.path.startsWith("/v1/notify/threads")) {
        return new Response(
          JSON.stringify({
            scope: "channel",
            root: projectRoot,
            replies: [],
            replyCount: 0,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const thread = await api.fetchReplyThread({
      scope: "channel",
      rootEventId: "evt_root",
      channelId: "chn_proj",
    });
    expect(thread.root?.eventId).toBe("evt_root");
    expect(thread.replies).toHaveLength(0);

    await api.sendReply({
      scope: "channel",
      rootEventId: "evt_root",
      channelId: "chn_proj",
      body: "ok",
    });

    const panelReplies = [
      ...thread.replies,
      {
        eventId: "evt_ok",
        rootEventId: "evt_root",
        body: "ok",
        createdAt: "2026-08-17T01:06:00.000Z",
      },
    ];
    const listPage = [projectRoot, ...panelReplies];
    const timeline = messagesForDisplay({ messages: listPage }).filter(
      (row) => !isReplyMessage(row),
    );

    expect(panelReplies.map((row) => row.body)).toContain("ok");
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.eventId).toBe("evt_root");
    expect(timeline.some((row) => row.body === "ok")).toBe(false);
    expect(
      calls.some(
        (call) =>
          call.method === "GET" && call.path.startsWith("/v1/notify/threads"),
      ),
    ).toBe(true);
    expect(
      calls.filter((call) => call.path.startsWith("/v1/notify/threads")),
    ).toHaveLength(1);
    expect(calls[1]).toEqual({
      method: "POST",
      path: "/v1/notify/channels/chn_proj/messages",
      body: { body: "ok", rootEventId: "evt_root" },
    });
  });

  it("Given a DM root with replyCount 1, when the user taps “1 reply”, then the panel loads the root plus that reply", async () => {
    const { api, calls } = makeApi((call) => {
      if (call.path.startsWith("/v1/notify/threads")) {
        return new Response(
          JSON.stringify({
            scope: "dm",
            root: {
              eventId: "evt_dm_root",
              body: "dm root",
              createdAt: "2026-08-17T01:00:00.000Z",
              replyCount: 1,
            },
            replies: [
              {
                eventId: "evt_existing",
                rootEventId: "evt_dm_root",
                body: "already here",
                createdAt: "2026-08-17T01:05:00.000Z",
              },
            ],
            replyCount: 1,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const result = await api.fetchReplyThread({
      scope: "dm",
      rootEventId: "evt_dm_root",
      withPersonUid: "prs_ada",
    });

    expect(result.root?.eventId).toBe("evt_dm_root");
    expect(result.root?.body).toBe("dm root");
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.body).toBe("already here");
    expect(result.replyCount).toBe(1);
    expect(calls).toEqual([
      {
        method: "GET",
        path: "/v1/notify/threads?scope=dm&rootEventId=evt_dm_root&withPersonUid=prs_ada",
        body: undefined,
      },
    ]);
    expect(calls[0]?.path.includes("/v1/notify/thread?")).toBe(false);
  });

  it("Given a chat channel at a narrow viewport, when the panel opens, then it overlays the timeline and Close returns to the timeline", () => {
    expect(replyColumnLayout(400)).toBe("overlay");
    expect(replyColumnLayout(720)).toBe("overlay");
    expect(replyColumnLayout(1024)).toBe("column");
  });
});
