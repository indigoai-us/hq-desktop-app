import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDesktopAdapter,
  failure,
  ok,
  replyScopeForRow,
  WebPlatformAdapter,
  type PlatformAdapter,
} from "@hq/platform";
import { replyScopeForRow as uiReplyScopeForRow } from "../../../../packages/ui/src/chat/chat-api.js";

import {
  createChatSidebarApi,
  createConversationApi,
  resetLiveRailHydrate,
} from "./chat-adapter.js";

function stubAdapter(
  fetchChannelDirectory: PlatformAdapter["messaging"]["fetchChannelDirectory"],
): PlatformAdapter {
  return {
    messaging: {
      fetchChannelDirectory,
      listContacts: async () => ok({ contacts: [] }),
    },
    identity: {
      whoami: async () => ok({ personUid: "prs_me" }),
    },
    notifications: {
      fetchDmInbox: async () => ok({ events: [], pairUnreads: [] }),
    },
  } as unknown as PlatformAdapter;
}

describe("hydrateLiveRail", () => {
  beforeEach(() => {
    resetLiveRailHydrate();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ items: [] }), { status: 200 }),
      ),
    );
  });

  afterEach(() => {
    resetLiveRailHydrate();
    vi.unstubAllGlobals();
  });

  it("retries after a rejected hydrate instead of keeping the failed promise", async () => {
    const calls: Array<string | undefined> = [];
    const adapter = stubAdapter(async (cursor) => {
      calls.push(cursor);
      if (calls.length === 1) {
        return failure("http-401", "GET /v1/notify/channels failed");
      }
      return ok({
        snapshot: true,
        cursor: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        cursorExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        rows: [{ channelId: "chn_1", name: "alpha" }],
      });
    });
    const api = createChatSidebarApi(adapter);

    await expect(api.fetchChannelDirectory(null)).rejects.toThrow(
      /GET \/v1\/notify\/channels failed/,
    );
    const feed = await api.fetchChannelDirectory(null);
    expect(feed.rows).toEqual([
      expect.objectContaining({ channelId: "chn_1" }),
    ]);
    expect(calls).toEqual([undefined, undefined]);
  });

  it("keeps the previous notify directory when the live fetch 401s", async () => {
    const adapter = stubAdapter(async () =>
      failure("http-401", "GET /v1/notify/channels failed"),
    );
    const api = createChatSidebarApi(adapter, [
      {
        channelId: "chn_cached",
        scope: "project",
        name: "work-mesh-testing",
        lastActivityAt: "2026-04-01T12:00:00.000Z",
      },
    ]);
    const feed = await api.fetchChannelDirectory(null);
    expect(feed.rows).toEqual([
      expect.objectContaining({ channelId: "chn_cached" }),
    ]);
  });

  it("does not send the synthetic livefeed cursor to the API", async () => {
    const calls: Array<string | undefined> = [];
    const adapter = stubAdapter(async (cursor) => {
      calls.push(cursor);
      return ok({
        snapshot: true,
        cursor: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        cursorExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        rows: [{ channelId: "chn_1", name: "alpha" }],
      });
    });
    const api = createChatSidebarApi(adapter);

    await api.fetchChannelDirectory("livefeed0000000000000000000000000000");
    expect(calls).toEqual([undefined]);
  });
});

interface RecordedHttp {
  method: string;
  path: string;
  body: unknown;
}

function threadPayload(overrides: Record<string, unknown> = {}) {
  return {
    scope: "channel",
    root: {
      eventId: "evt_root",
      body: "root body",
      createdAt: "2026-08-17T01:00:00.000Z",
      replyCount: 1,
    },
    replies: [
      {
        eventId: "evt_reply",
        rootEventId: "evt_root",
        body: "reply body",
        createdAt: "2026-08-17T02:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function makeReplyFetch(handler?: (call: RecordedHttp) => Response) {
  const calls: RecordedHttp[] = [];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const path = url.replace("https://api.test", "");
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    const call = { method, path, body };
    calls.push(call);
    if (handler) return handler(call);
    if (path.startsWith("/v1/notify/threads")) {
      return new Response(JSON.stringify(threadPayload()), { status: 200 });
    }
    if (method === "POST") {
      return new Response(JSON.stringify({ eventId: "evt_new" }), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  };
  const adapter = new WebPlatformAdapter({
    baseUrl: "https://api.test",
    fetch: fetchMock,
  });
  return { adapter, api: createConversationApi(adapter), calls };
}

describe("replyScopeForRow", () => {
  it("maps 1:1 DM, company/project channel, and group DM (kind=group + channelId)", () => {
    expect(replyScopeForRow({ kind: "dm", personUid: "prs_ada" })).toBe("dm");
    expect(uiReplyScopeForRow({ kind: "dm", personUid: "prs_ada" })).toBe("dm");
    expect(replyScopeForRow({ kind: "channel", channelId: "chn_proj" })).toBe(
      "channel",
    );
    expect(replyScopeForRow({ kind: "group", channelId: "chn_group" })).toBe(
      "channel",
    );
    expect(replyScopeForRow({ kind: "dm" })).toBeNull();
    expect(
      replyScopeForRow({
        kind: "dm",
        personUid: "prs_ada",
        channelId: "chn_group",
      }),
    ).toBe("channel");
  });
});

describe("fetchReplyThread / sendReply adapters", () => {
  it("fetches a 1:1 DM reply thread via GET /v1/notify/threads", async () => {
    const { api, calls } = makeReplyFetch((call) => {
      if (call.path.startsWith("/v1/notify/threads")) {
        return new Response(
          JSON.stringify(
            threadPayload({
              scope: "dm",
              root: {
                eventId: "evt_root",
                body: "dm root",
                createdAt: "2026-08-17T01:00:00.000Z",
                replyCount: 1,
              },
            }),
          ),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const scope = replyScopeForRow({ kind: "dm", personUid: "prs_ada" });
    expect(scope).toBe("dm");
    const result = await api.fetchReplyThread({
      scope: "dm",
      rootEventId: "evt_root",
      withPersonUid: "prs_ada",
    });
    expect(result.root?.eventId).toBe("evt_root");
    expect(result.replies).toHaveLength(1);
    expect(result.replyCount).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe(
      "/v1/notify/threads?scope=dm&rootEventId=evt_root&withPersonUid=prs_ada",
    );
    expect(calls[0]?.path.includes("/v1/notify/thread?")).toBe(false);
  });

  it("fetches a company/project channel reply thread via GET /v1/notify/threads", async () => {
    const { api, calls } = makeReplyFetch();
    const result = await api.fetchReplyThread({
      scope: "channel",
      rootEventId: "evt_root",
      channelId: "chn_proj",
    });
    expect(result.root?.eventId).toBe("evt_root");
    expect(result.replies.map((row) => row.eventId)).toEqual(["evt_reply"]);
    expect(result.replyCount).toBe(1);
    expect(calls[0]?.path).toBe(
      "/v1/notify/threads?scope=channel&rootEventId=evt_root&channelId=chn_proj",
    );
  });

  it("treats group DM (kind=group + channelId) as scope=channel", async () => {
    const { api, calls } = makeReplyFetch();
    const scope = replyScopeForRow({
      kind: "group",
      channelId: "chn_group",
    });
    expect(scope).toBe("channel");
    await api.fetchReplyThread({
      scope: "channel",
      rootEventId: "evt_root",
      channelId: "chn_group",
    });
    expect(calls[0]?.path).toBe(
      "/v1/notify/threads?scope=channel&rootEventId=evt_root&channelId=chn_group",
    );
  });

  it("surfaces 404 THREAD_NOT_FOUND from GET /v1/notify/threads", async () => {
    const { api, calls } = makeReplyFetch(
      () =>
        new Response(
          JSON.stringify({
            error: "Thread not found",
            code: "THREAD_NOT_FOUND",
          }),
          { status: 404 },
        ),
    );
    await expect(
      api.fetchReplyThread({
        scope: "channel",
        rootEventId: "evt_missing",
        channelId: "chn_proj",
      }),
    ).rejects.toThrow(/THREAD_NOT_FOUND/);
    expect(calls[0]?.path.startsWith("/v1/notify/threads")).toBe(true);
  });

  it("surfaces 400 for missing rootEventId without hitting the network", async () => {
    const { api, calls } = makeReplyFetch();
    await expect(
      api.fetchReplyThread({
        scope: "channel",
        rootEventId: "",
        channelId: "chn_proj",
      }),
    ).rejects.toThrow(/\[http-400\].*rootEventId/);
    expect(calls).toEqual([]);
  });

  it("surfaces 400 for scope=dm without withPersonUid and does not hit a wrong partition", async () => {
    const { api, calls } = makeReplyFetch();
    await expect(
      api.fetchReplyThread({
        scope: "dm",
        rootEventId: "evt_root",
      }),
    ).rejects.toThrow(/\[http-400\].*withPersonUid/);
    expect(calls).toEqual([]);
    expect(calls.some((call) => call.path.includes("/v1/notify/thread?"))).toBe(
      false,
    );
  });

  it("sendReply on a project channel POSTs rootEventId and leaves send-without-root untouched", async () => {
    const { api, calls } = makeReplyFetch();
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
    await api.sendDm({ toPersonUid: "prs_ada", body: "hi" });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/notify/channels/chn_proj/messages",
        body: { body: "ok", rootEventId: "evt_root" },
      },
      {
        method: "POST",
        path: "/v1/notify/channels/chn_proj/messages",
        body: { body: "top-level" },
      },
      {
        method: "POST",
        path: "/v1/notify/dm",
        body: { toPersonUid: "prs_ada", body: "hi" },
      },
    ]);
  });

  it("sendDm POSTs /v1/notify/dm with toPersonUid, including agent recipients", async () => {
    const { api, calls } = makeReplyFetch();
    await api.sendDm({
      toPersonUid: "agt_01KTX6WQ6SYH3TZGF3DSDRPGD",
      body: "hello deacon",
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/notify/dm",
        body: {
          toPersonUid: "agt_01KTX6WQ6SYH3TZGF3DSDRPGD",
          body: "hello deacon",
        },
      },
    ]);
    expect(calls.some((call) => call.path.includes("/v1/notify/dm/"))).toBe(
      false,
    );
  });

  it("desktop sendReply is cache-first via hq_pro_fetch and does not GET the reply thread", async () => {
    const fetchCalls: RecordedHttp[] = [];
    const invokeCalls: string[] = [];
    const adapter = createDesktopAdapter({
      invoke: async (cmd) => {
        invokeCalls.push(cmd);
        return {};
      },
      baseUrl: "https://api.test",
      fetch: async (input, init) => {
        const path = String(input).replace("https://api.test", "");
        fetchCalls.push({
          method: (init?.method ?? "GET").toUpperCase(),
          path,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({ eventId: "evt_new" }), {
          status: 200,
        });
      },
    });
    const api = createConversationApi(adapter);
    await api.sendReply({
      scope: "channel",
      rootEventId: "evt_root",
      channelId: "chn_proj",
      body: "ok",
    });
    expect(fetchCalls).toEqual([
      {
        method: "POST",
        path: "/v1/notify/channels/chn_proj/messages",
        body: { body: "ok", rootEventId: "evt_root" },
      },
    ]);
    expect(fetchCalls.some((call) => call.path.includes("/threads"))).toBe(
      false,
    );
    expect(invokeCalls).toEqual([]);
  });
});
