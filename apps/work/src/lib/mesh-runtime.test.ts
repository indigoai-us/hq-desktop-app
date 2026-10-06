import { describe, expect, it, vi } from "vitest";

import {
  PresenceStore,
  parseReplyThreadWake,
  routeForReplyThreadWake,
  routeForTopic,
} from "@hq/core";
import {
  createChatWakeBus,
  presenceStatus,
  requestLiveRefresh,
  type ReplyNewWake,
} from "@hq/ui";

import {
  routeMeshReconcile,
  routeMeshWake,
  startWebMesh,
  startWebMeshForAdapter,
} from "./mesh-runtime.js";

const meshClients = vi.hoisted(() => ({
  instances: [] as Array<{
    emit: (event: string, ...args: unknown[]) => void;
    refreshCalls: string[];
  }>,
}));

vi.mock("@hq/core", async () => {
  const actual = await vi.importActual<typeof import("@hq/core")>("@hq/core");
  class TestMeshClient {
    private readonly handlers = new Map<
      string,
      Array<(...args: unknown[]) => void>
    >();
    readonly refreshCalls: string[] = [];

    constructor() {
      meshClients.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    }

    start(): Promise<void> {
      return Promise.resolve();
    }

    stop(): void {
      this.handlers.clear();
    }

    refreshLive(companyUid: string): void {
      this.refreshCalls.push(companyUid);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  return { ...actual, MeshClient: TestMeshClient };
});

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

  it("maps the directory doorbell onto a directory refresh only", () => {
    const wakes = createChatWakeBus();
    const seen: string[] = [];
    wakes.on("channel:unread-changed", () => seen.push("unread"));
    wakes.on("channel:new-message", () => seen.push("channel"));
    wakes.on("dm:new-message", () => seen.push("dm"));
    expect(
      routeMeshWake(
        {
          contractVersion: 2,
          eventType: "channel.directory.changed",
          scope: "work",
          resourceId: "chn_x",
        },
        wakes,
      ),
    ).toBe("directory");
    expect(seen).toEqual(["unread"]);
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

describe("startWebMesh behavior", () => {
  it("routes wake, catchup, and connection events onto the chat bus", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const wakes = createChatWakeBus();
    const catchups: string[] = [];
    const connections: string[] = [];
    let dmMessages = 0;
    const onNotifications = vi.fn();
    wakes.on("mesh:catchup", ({ reason }) => catchups.push(reason));
    wakes.on("mesh:connection", ({ state }) => connections.push(state));
    wakes.on("dm:new-message", () => {
      dmMessages += 1;
    });

    const mesh = startWebMesh({ wakes, onNotifications });
    const client = meshClients.instances.at(-1)!;
    try {
      client.emit("catchup", "focus");
      client.emit("connectionState", "connected");
      client.emit(
        "wake",
        "hq/prs_reader/dm",
        JSON.stringify({
          type: "dm",
          eventId: "evt_dm",
          createdAt: "2026-08-22T12:00:00.000Z",
          fromPersonUid: "agt_deacon",
        }),
      );

      expect(catchups).toEqual(["focus"]);
      expect(connections).toEqual(["connected"]);
      expect(dmMessages).toBe(1);
      expect(onNotifications).toHaveBeenCalledOnce();
      expect(info).toHaveBeenCalledWith("[hq-web-mesh]", {
        event: "catchup",
        reason: "focus",
      });
      expect(info).toHaveBeenCalledWith("[hq-web-mesh]", {
        event: "connection",
        state: "connected",
      });
    } finally {
      mesh.stop();
      info.mockRestore();
    }
  });

  it("publishes presence updates to the chat bus and reactive snapshot", async () => {
    const wakes = createChatWakeBus();
    const presenceStore = new PresenceStore();
    const changes: Array<{
      companyUid: string;
      actorUid: string;
      status: string;
    }> = [];
    wakes.on("presence:changed", (change) => changes.push(change));

    const mesh = startWebMesh({ wakes, presenceStore });
    const client = meshClients.instances.at(-1)!;
    let stopped = false;
    try {
      requestLiveRefresh(" cmp_test ");
      expect(client.refreshCalls).toEqual(["cmp_test"]);

      presenceStore.replaceCompany("cmp_test", [
        {
          actorUid: "agt_test",
          actorType: "agent",
          presence: "online",
          lastSeenAt: "2026-08-22T12:00:00.000Z",
        },
      ]);
      await Promise.resolve();

      expect(changes).toEqual([
        { companyUid: "cmp_test", actorUid: "agt_test", status: "online" },
      ]);
      expect(presenceStatus("cmp_test", "agt_test")).toBe("online");

      mesh.stop();
      stopped = true;
      requestLiveRefresh("cmp_test");
      expect(client.refreshCalls).toEqual(["cmp_test"]);
      expect(presenceStatus("cmp_test", "agt_test")).toBeNull();
      presenceStore.replaceCompany("cmp_test", [
        {
          actorUid: "agt_test",
          actorType: "agent",
          presence: "offline",
          lastSeenAt: "2026-08-22T12:01:00.000Z",
        },
      ]);
      await Promise.resolve();
      expect(changes).toHaveLength(1);
    } finally {
      if (!stopped) mesh.stop();
    }
  });
});

describe("browser mesh target gate", () => {
  it("starts the browser mesh for web and never for desktop", () => {
    const wakes = createChatWakeBus();
    const mesh = {
      stop: vi.fn(),
      presenceStore: {} as never,
      presenceSnapshot: () => new Map(),
      liveReadStore: {} as never,
    };
    const start = vi.fn(() => mesh);
    const opts = { wakes, fetchImpl: vi.fn() as unknown as typeof fetch };

    expect(startWebMeshForAdapter({ kind: "web" }, opts, start)).toBe(mesh);
    expect(startWebMeshForAdapter({ kind: "desktop" }, opts, start)).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(opts);
  });
});
