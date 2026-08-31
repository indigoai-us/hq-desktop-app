import { describe, expect, it } from "vitest";

import {
  parseReplyThreadWake,
  routeForReplyThreadWake,
  routeForTopic,
} from "@hq/core";
import { createChatWakeBus, type ReplyNewWake } from "@hq/ui";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { routeMeshReconcile, routeMeshWake } from "./mesh-runtime.js";

describe("routeMeshReconcile", () => {
  it("maps notification / dm / thread wakes to the sidebar bus", () => {
    const wakes = createChatWakeBus();
    const seen: string[] = [];
    wakes.on("channel:unread-changed", () => seen.push("dir"));
    wakes.on("dm:pair-unreads", () => seen.push("dm"));

    expect(
      routeMeshReconcile(
        {
          resource: "notifications:prs_1",
          path: "/v1/notify/notifications",
          state: {},
        },
        wakes,
      ),
    ).toBe("notifications");
    expect(
      routeMeshReconcile(
        {
          resource: "dm:prs_1",
          path: "/v1/notify/inbox",
          state: { pairUnreads: [] },
        },
        wakes,
      ),
    ).toBe("dm");
    expect(
      routeMeshReconcile(
        {
          resource: "thread:cmp:t1",
          path: "/v1/work-mesh/companies/cmp/threads/t1",
          state: {},
        },
        wakes,
      ),
    ).toBe("directory");
    expect(seen).toEqual(["dm", "dir"]);
  });

  it("maps hq-pro type:thread reconcile onto reply:new and not type:channel", () => {
    const wakes = createChatWakeBus();
    const replies: ReplyNewWake[] = [];
    const other: string[] = [];
    wakes.on("reply:new", (payload) => replies.push(payload));
    wakes.on("channel:unread-changed", () => other.push("unread"));
    wakes.on("channel:new-message", () => other.push("channel"));
    wakes.on("dm:pair-unreads", () => other.push("dm"));

    expect(
      routeMeshReconcile(
        {
          resource: "reply:channel:evt_root",
          path: "/v1/notify/threads?rootEventId=evt_root&scope=channel&channelId=chn_1",
          state: { body: "must-not-apply" },
          replyWake: {
            rootEventId: "evt_root",
            eventId: "evt_reply",
            scope: "channel",
            channelId: "chn_1",
          },
        },
        wakes,
      ),
    ).toBe("reply");
    expect(replies).toEqual([
      {
        rootEventId: "evt_root",
        eventId: "evt_reply",
        scope: "channel",
        channelId: "chn_1",
      },
    ]);
    expect(other).toEqual([]);
  });
});

describe("routeMeshWake", () => {
  it("maps hq-pro type:thread payloads onto reply:new (ids only)", () => {
    const wakes = createChatWakeBus();
    const replies: ReplyNewWake[] = [];
    const other: string[] = [];
    wakes.on("reply:new", (payload) => replies.push(payload));
    wakes.on("channel:unread-changed", () => other.push("unread"));
    wakes.on("channel:new-message", () => other.push("channel"));

    expect(
      routeMeshWake(
        {
          type: "thread",
          scope: "channel",
          rootEventId: "evt_root",
          eventId: "evt_b",
          channelId: "chn_proj",
          createdAt: "2026-08-18T00:00:00.000Z",
          fromPersonUid: "prs_b",
          body: "must-not-leak",
        },
        wakes,
      ),
    ).toBe("reply");
    expect(replies).toEqual([
      {
        rootEventId: "evt_root",
        eventId: "evt_b",
        scope: "channel",
        channelId: "chn_proj",
      },
    ]);
    expect(JSON.stringify(replies[0])).not.toContain("must-not-leak");
    expect(other).toEqual([]);
  });

  it("maps hq-pro type:dm payloads onto dm:new-message", () => {
    const wakes = createChatWakeBus();
    const dms: Array<{ fromPersonUid: string }> = [];
    wakes.on("dm:new-message", (payload) => dms.push(payload));
    wakes.on("channel:new-message", () =>
      dms.push({ fromPersonUid: "channel" }),
    );
    expect(
      routeMeshWake(
        {
          type: "dm",
          eventId: "evt_dm",
          createdAt: "2026-08-22T12:00:00.000Z",
          fromPersonUid: "agt_deacon",
        },
        wakes,
      ),
    ).toBe("dm");
    expect(dms).toEqual([
      {
        fromPersonUid: "agt_deacon",
        eventId: "evt_dm",
        createdAt: "2026-08-22T12:00:00.000Z",
      },
    ]);
  });

  it("does not treat work-mesh thread_event as reply:new", () => {
    const wakes = createChatWakeBus();
    let replies = 0;
    wakes.on("reply:new", () => {
      replies += 1;
    });
    expect(
      routeMeshWake(
        {
          type: "thread_event",
          eventId: "e1",
          threadId: "t1",
          companyUid: "cmp_x",
        },
        wakes,
      ),
    ).toBeNull();
    expect(replies).toBe(0);
    expect(routeForTopic("hq/cmp_x/thread/t1")?.path).toBe(
      "/v1/work-mesh/companies/cmp_x/threads/t1",
    );
  });
});

describe("parseReplyThreadWake / routeForReplyThreadWake", () => {
  it("routes type:thread to GET /v1/notify/threads, not the conversation GET", () => {
    const wake = {
      type: "thread",
      scope: "dm",
      rootEventId: "evt_root",
      eventId: "evt_r",
      fromPersonUid: "prs_ada",
    };
    expect(parseReplyThreadWake(wake)).toEqual({
      rootEventId: "evt_root",
      eventId: "evt_r",
      scope: "dm",
      withPersonUid: "prs_ada",
    });
    const route = routeForReplyThreadWake(wake);
    expect(route?.path).toBe(
      "/v1/notify/threads?rootEventId=evt_root&scope=dm&withPersonUid=prs_ada",
    );
    expect(route?.resource).toBe("reply:dm:evt_root");
    expect(routeForTopic("hq/prs_alice/dm")?.path).toBe("/v1/notify/inbox");
  });
});

describe("startWebMesh wake-bus contract", () => {
  it("fans MQTT catchup and connection onto the chat bus like desktop", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./mesh-runtime.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain('opts.wakes.emit("mesh:catchup"');
    expect(src).toContain('opts.wakes.emit("mesh:connection"');
    expect(src).toContain("routeMeshWake(payloadText, opts.wakes)");
    expect(src).toContain("[hq-web-mesh]");
  });
});
