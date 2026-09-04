/**
 * US-004 story acceptance tests (from PRD e2eTests):
 *
 * 1. Given user A has a reply panel open on root R, when user B’s reply to R
 *    is durable and a type:thread wake fires, then A’s panel shows B’s reply
 *    without a manual refresh.
 * 2. Given a wake for a different root, when A’s panel is open on R, then
 *    the panel contents do not change.
 *
 * Follows the US-001/US-002/US-007 story-test convention: vitest drives the
 * real WebPlatformAdapter + mesh-runtime mapping with a mocked fetch. No live
 * Cognito. Wake event is reply:new — never thread:.
 */

import { describe, expect, it } from "vitest";

import {
  parseReplyThreadWake,
  routeForReplyThreadWake,
  routeForTopic,
  WakeReconciler,
} from "@hq/core";
import { WebPlatformAdapter } from "@hq/platform";
import {
  bumpRootReplyCount,
  createChatWakeBus,
  isReplyMessage,
  type ConversationMessageWire,
  type ReplyNewWake,
} from "@hq/ui";

import { createConversationApi } from "../../src/lib/chat-adapter.js";
import {
  routeMeshReconcile,
  routeMeshWake,
} from "../../src/lib/mesh-runtime.js";

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

const root: ConversationMessageWire = {
  eventId: "evt_root",
  body: "root body",
  createdAt: "2026-08-17T01:00:00.000Z",
  fromDisplayName: "Ada",
  replyCount: 1,
};

const replyA: ConversationMessageWire = {
  eventId: "evt_a",
  rootEventId: "evt_root",
  body: "already here",
  createdAt: "2026-08-17T01:05:00.000Z",
  fromDisplayName: "Ada",
};

const replyB: ConversationMessageWire = {
  eventId: "evt_b",
  rootEventId: "evt_root",
  body: "from B",
  createdAt: "2026-08-17T01:10:00.000Z",
  fromDisplayName: "Bea",
};

describe("US-004: type:thread wake refreshes an open reply panel", () => {
  it("Given user A has a reply panel open on root R, when user B’s reply to R is durable and a type:thread wake fires, then A’s panel shows B’s reply without a manual refresh", async () => {
    let replies = [replyA];
    const { api, calls } = makeApi((call) => {
      if (call.path.startsWith("/v1/notify/threads")) {
        return new Response(
          JSON.stringify({
            scope: "channel",
            root: { ...root, replyCount: replies.length },
            replies,
            replyCount: replies.length,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const first = await api.fetchReplyThread({
      scope: "channel",
      rootEventId: "evt_root",
      channelId: "chn_proj",
    });
    expect(first.replies.map((row) => row.body)).toEqual(["already here"]);

    const wakes = createChatWakeBus();
    const doorbells: ReplyNewWake[] = [];
    wakes.on("reply:new", (payload) => doorbells.push(payload));

    const mqtt = {
      type: "thread",
      scope: "channel",
      rootEventId: "evt_root",
      eventId: "evt_b",
      channelId: "chn_proj",
      createdAt: "2026-08-18T00:00:00.000Z",
      fromPersonUid: "prs_b",
      body: "from B",
    };
    expect(routeMeshWake(mqtt, wakes)).toBe("reply");
    expect(doorbells).toEqual([
      {
        rootEventId: "evt_root",
        eventId: "evt_b",
        scope: "channel",
        channelId: "chn_proj",
      },
    ]);
    expect(JSON.stringify(doorbells[0])).not.toContain("from B");

    replies = [replyA, replyB];
    const next = await api.fetchReplyThread({
      scope: "channel",
      rootEventId: doorbells[0]!.rootEventId,
      channelId: doorbells[0]!.channelId,
    });
    expect(next.replies.map((row) => row.body)).toEqual([
      "already here",
      "from B",
    ]);
    expect(next.replyCount).toBe(2);
    expect(
      calls.every((call) => call.path.startsWith("/v1/notify/threads")),
    ).toBe(true);
    expect(calls.some((call) => call.path.includes("/v1/notify/thread?"))).toBe(
      false,
    );
  });

  it("Given a wake for a different root, when A’s panel is open on R, then the panel contents do not change", async () => {
    const { api } = makeApi((call) => {
      if (call.path.includes("rootEventId=evt_root")) {
        return new Response(
          JSON.stringify({
            scope: "channel",
            root,
            replies: [replyA],
            replyCount: 1,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const open = await api.fetchReplyThread({
      scope: "channel",
      rootEventId: "evt_root",
      channelId: "chn_proj",
    });
    const wakes = createChatWakeBus();
    let refetch = 0;
    wakes.on("reply:new", (payload) => {
      if (payload.rootEventId === "evt_root") refetch += 1;
    });
    expect(
      routeMeshWake(
        {
          type: "thread",
          scope: "channel",
          rootEventId: "evt_other",
          eventId: "evt_x",
          channelId: "chn_proj",
        },
        wakes,
      ),
    ).toBe("reply");
    expect(refetch).toBe(0);
    expect(open.replies.map((row) => row.body)).toEqual(["already here"]);
    expect(open.replyCount).toBe(1);
  });

  it("type:thread does not also fire type:channel and does not invent sidebar unread", () => {
    const wakes = createChatWakeBus();
    const seen: string[] = [];
    wakes.on("reply:new", () => seen.push("reply"));
    wakes.on("channel:unread-changed", () => seen.push("unread"));
    wakes.on("channel:new-message", () => seen.push("channel"));
    wakes.on("dm:pair-unreads", () => seen.push("dm"));

    expect(
      routeMeshReconcile(
        {
          resource: "reply:channel:evt_root",
          path: "/v1/notify/threads?rootEventId=evt_root&scope=channel",
          state: { body: "nope" },
          replyWake: parseReplyThreadWake({
            type: "thread",
            scope: "channel",
            rootEventId: "evt_root",
            eventId: "evt_b",
            channelId: "chn_proj",
          })!,
        },
        wakes,
      ),
    ).toBe("reply");
    expect(seen).toEqual(["reply"]);
    expect(routeForTopic("hq/cmp_x/thread/t1")?.path).toContain("work-mesh");
    expect(
      routeForReplyThreadWake({
        type: "thread",
        scope: "channel",
        rootEventId: "evt_root",
        eventId: "evt_b",
        channelId: "chn_proj",
      })?.path.startsWith("/v1/notify/threads"),
    ).toBe(true);
  });

  it("a channel:new-message hydrate still hides replies via isReplyMessage", () => {
    const page = [replyB, { ...root, replyCount: 2 }];
    const timeline = page.filter((row) => !isReplyMessage(row));
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.eventId).toBe("evt_root");
    expect(bumpRootReplyCount(timeline, "evt_root")[0]?.replyCount).toBe(3);
  });

  it("WakeReconciler treats type:thread as a targeted /threads fetch, not a conversation GET", async () => {
    const paths: string[] = [];
    const reconciled: string[] = [];
    const reconciler = new WakeReconciler(
      async (route) => {
        paths.push(route.path);
        return { state: { path: route.path } };
      },
      (result) => reconciled.push(result.resource),
    );
    expect(
      reconciler.wake("hq/prs_a/dm", {
        type: "thread",
        scope: "channel",
        rootEventId: "evt_root",
        eventId: "evt_b",
        channelId: "chn_proj",
      }),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(paths).toEqual([
      "/v1/notify/threads?rootEventId=evt_root&scope=channel&channelId=chn_proj",
    ]);
    expect(reconciled).toEqual(["reply:channel:evt_root"]);
    expect(paths.some((path) => path === "/v1/notify/dm")).toBe(false);
  });
});
