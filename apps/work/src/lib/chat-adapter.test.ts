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
  hydrateLiveRail,
  resetLiveRailHydrate,
} from "./chat-adapter.js";
import {
  EMPTY_SHALLOW_CACHE,
  mergeShallowCache,
  readShallowCache,
  writeShallowCache,
} from "./browser-cache.js";

function stubAdapter(
  fetchChannelDirectory: PlatformAdapter["messaging"]["fetchChannelDirectory"],
  listContacts: PlatformAdapter["messaging"]["listContacts"] = async () =>
    ok([]),
): PlatformAdapter {
  return {
    messaging: {
      fetchChannelDirectory,
      listContacts,
    },
    identity: {
      whoami: async () => ok({ personUid: "prs_me" }),
    },
    notifications: {
      fetchDmInbox: async () => ok({ events: [], pairUnreads: [] }),
    },
  } as unknown as PlatformAdapter;
}

function shallowStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: () => null,
    get length() {
      return values.size;
    },
  };
}

describe("hydrateLiveRail", () => {
  beforeEach(() => {
    resetLiveRailHydrate();
    vi.stubGlobal("localStorage", shallowStorage());
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

  it("persists the successful fallback rail bundle after a directory failure", async () => {
    const personUid = "prs_me";
    const previousDirectory = [
      {
        channelId: "chn_previous",
        scope: "company",
        name: "Previous directory row",
        lastActivityAt: "2026-08-21T10:00:00.000Z",
      },
    ];
    const freshContacts = [
      {
        personUid: "prs_fresh",
        displayName: "Fresh contact",
      },
    ];
    writeShallowCache(
      mergeShallowCache(
        EMPTY_SHALLOW_CACHE,
        {
          directory: [
            {
              channelId: "chn_stale",
              scope: "company",
              name: "Stale directory",
              lastActivityAt: "2026-08-20T10:00:00.000Z",
            },
          ],
          contacts: [
            { personUid: "prs_stale", displayName: "Stale contact" },
          ],
        },
        personUid,
      ),
    );
    const adapter = stubAdapter(
      async () =>
        failure("http-401", "GET /v1/notify/channels failed"),
      async () => ok(freshContacts),
    );

    const rail = await hydrateLiveRail(adapter, previousDirectory, personUid);
    const cache = readShallowCache(personUid);

    expect(rail.directory).toEqual(previousDirectory);
    expect(cache.directory).toEqual(rail.directory);
    expect(cache.contacts).toEqual(freshContacts);
  });

  it("does not overwrite cached contacts from a failed fallback roster fetch", async () => {
    const personUid = "prs_me";
    const cachedContacts = [
      { personUid: "prs_cached", displayName: "Cached contact" },
    ];
    writeShallowCache(
      mergeShallowCache(
        EMPTY_SHALLOW_CACHE,
        { contacts: cachedContacts },
        personUid,
      ),
    );
    const adapter = stubAdapter(
      async () =>
        failure("http-401", "GET /v1/notify/channels failed"),
      async () => Promise.reject(new Error("GET /v1/notify/contacts failed")),
    );

    await hydrateLiveRail(
      adapter,
      [
        {
          channelId: "chn_previous",
          scope: "company",
          name: "Previous directory row",
          lastActivityAt: "2026-08-21T10:00:00.000Z",
        },
      ],
      personUid,
    );

    expect(readShallowCache(personUid).contacts).toEqual(cachedContacts);
  });

  it("preserves cached contacts when the live roster fetch rejects", async () => {
    const personUid = "prs_me";
    const cachedContact = {
      personUid: "prs_cached",
      displayName: "Cached contact",
    };
    writeShallowCache(
      mergeShallowCache(
        EMPTY_SHALLOW_CACHE,
        { contacts: [cachedContact] },
        personUid,
      ),
    );
    const adapter = stubAdapter(
      async () =>
        ok({
          snapshot: true,
          cursor: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          cursorExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          rows: [],
        }),
      async () => Promise.reject(new Error("GET /v1/notify/contacts failed")),
    );

    const rail = await hydrateLiveRail(adapter, [], personUid);

    expect(rail.contacts).toEqual([
      expect.objectContaining({ personUid: cachedContact.personUid }),
    ]);
    expect(readShallowCache(personUid).contacts).toEqual([
      expect.objectContaining({ personUid: cachedContact.personUid }),
    ]);
  });

  it("overwrites cached contacts when the live roster is genuinely empty", async () => {
    const personUid = "prs_me";
    writeShallowCache(
      mergeShallowCache(
        EMPTY_SHALLOW_CACHE,
        {
          contacts: [
            {
              personUid: "prs_cached",
              displayName: "Cached contact",
            },
          ],
        },
        personUid,
      ),
    );
    const adapter = stubAdapter(async () =>
      ok({
        snapshot: true,
        cursor: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        cursorExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        rows: [],
      }),
    );

    await hydrateLiveRail(adapter, [], personUid);

    expect(readShallowCache(personUid).contacts).toEqual([]);
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

  it("coalesces overlapping hydrates but refreshes after they settle", async () => {
    type DirectoryResult = Awaited<
      ReturnType<PlatformAdapter["messaging"]["fetchChannelDirectory"]>
    >;
    let resolveFirst!: (value: DirectoryResult) => void;
    const first = new Promise<DirectoryResult>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchChannelDirectory = vi.fn<
      PlatformAdapter["messaging"]["fetchChannelDirectory"]
    >(async () => {
      if (fetchChannelDirectory.mock.calls.length === 1) return first;
      return ok({
        snapshot: true,
        cursor: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        cursorExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        rows: [{ channelId: "chn_2", name: "beta" }],
      });
    });
    const adapter = stubAdapter(fetchChannelDirectory);

    const initial = hydrateLiveRail(adapter);
    const overlapping = hydrateLiveRail(adapter);
    expect(overlapping).toBe(initial);
    expect(fetchChannelDirectory).toHaveBeenCalledTimes(1);

    resolveFirst(
      ok({
        snapshot: true,
        cursor: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        cursorExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        rows: [{ channelId: "chn_1", name: "alpha" }],
      }),
    );
    await initial;

    await hydrateLiveRail(adapter);
    expect(fetchChannelDirectory).toHaveBeenCalledTimes(2);
  });
});

describe("createChatSidebarApi", () => {
  it("forwards a compose DM's recipient and body to the platform adapter", async () => {
    const sendDm = vi.fn(async () => ok({}));
    const adapter = stubAdapter(async () =>
      ok({
        snapshot: true,
        cursor: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        cursorExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        rows: [],
      }),
    );
    adapter.messaging.sendDm = sendDm;

    await createChatSidebarApi(adapter).sendDm({
      toPersonUid: "prs_ada",
      body: "Please review the rollout.",
    });

    expect(sendDm).toHaveBeenCalledWith(
      "prs_ada",
      "Please review the rollout.",
      {},
    );
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
