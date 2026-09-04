/**
 * US-006 story acceptance tests (from PRD e2eTests):
 *
 * 1. Given fixtures for a DM, a chat channel, and a project channel each
 *    with one reply, when each conversation opens, then the main timeline
 *    hides the reply and “1 reply” opens the panel. Group DM is included
 *    (kind=group + channelId → scope=channel).
 * 2. Given the project fixture, when a reply is sent from the panel, then
 *    the main timeline still shows only the root and the root affordance
 *    increments.
 * 3. Given an open panel, when a type:thread wake fixture fires, then the
 *    new reply row appears. The same wake bumps replyCount when the panel
 *    is closed but the conversation is open.
 * 4. A 50-row first page of 40 replies + 10 roots over-fetches (or still
 *    shows those 10 roots) so the timeline is not empty.
 *
 * Follows the us-007 story-test convention: vitest drives the real
 * WebPlatformAdapter + createConversationApi + ConversationView hydrate
 * helpers (collectTimelineRoots / replyScopeForRow / bumpRootReplyCount)
 * and the real MeshClient / mesh-runtime mapping. Only fetch + MQTT are
 * fakes. No live Cognito. Product copy is “replies”, not a work-mesh
 * thread. Playwright’s smoke project ignores e2e/stories.
 */

import { describe, expect, it } from "vitest";

import { MeshClient, type MqttConnectFn } from "@hq/core";
import { WebPlatformAdapter } from "@hq/platform";
import {
  bumpRootReplyCount,
  createChatWakeBus,
  isReplyMessage,
  replyNewMatchesConversation,
  replyScopeForRow,
  type ConversationMessageWire,
  type ConversationRow,
  type ReplyNewWake,
  type ReplyThreadResponse,
} from "@hq/ui";

import { createConversationApi } from "../../src/lib/chat-adapter.js";
import {
  collectTimelineRoots,
  TIMELINE_ROOT_PAGE_SIZE,
} from "../../../../packages/ui/src/chat/live-messages.js";
import {
  createHqReconcileFetcher,
  routeMeshReconcile,
  routeMeshWake,
} from "../../src/lib/mesh-runtime.js";

// ---------------------------------------------------------------------------
// Deterministic seams — direct mocked hq-pro + mocked MQTT only
// ---------------------------------------------------------------------------

type Handler = (...args: unknown[]) => void;

class FakeMqttClient {
  handlers = new Map<string, Handler[]>();
  subscribed: string[][] = [];
  ended = 0;

  on(event: string, handler: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }
  subscribe(
    topics: string | string[],
    _opts: unknown,
    cb?: (err?: Error) => void,
  ): this {
    this.subscribed.push(Array.isArray(topics) ? topics : [topics]);
    cb?.();
    return this;
  }
  end(_force?: boolean): this {
    this.ended++;
    return this;
  }
  fire(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  expect(cond()).toBe(true);
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hrefOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const OVERFETCH_CURSOR = "overfetch-page-2";
const OVERFETCH_CHANNEL = "chn_overfetch";

const dmRow: ConversationRow = {
  id: "dm:prs_ada",
  kind: "dm",
  title: "Ada",
  companyUid: null,
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  personUid: "prs_ada",
};

const chatRow: ConversationRow = {
  id: "ch:chn_chat",
  kind: "channel",
  title: "general",
  companyUid: "cmp_acme",
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  channelId: "chn_chat",
  channelScope: "company",
};

const projectRow: ConversationRow = {
  id: "ch:chn_proj",
  kind: "channel",
  title: "launch",
  companyUid: "cmp_acme",
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  channelId: "chn_proj",
  channelScope: "project",
};

const groupRow: ConversationRow = {
  id: "ch:chn_group",
  kind: "group",
  title: "Design",
  companyUid: null,
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  channelId: "chn_group",
};

interface ConversationFixture {
  label: string;
  row: ConversationRow;
  rootEventId: string;
  rootBody: string;
  replyBody: string;
  expectedScope: "dm" | "channel";
}

const CONVERSATIONS: ConversationFixture[] = [
  {
    label: "1:1 DM",
    row: dmRow,
    rootEventId: "evt_dm_root",
    rootBody: "dm-root",
    replyBody: "dm-reply-hidden",
    expectedScope: "dm",
  },
  {
    label: "chat channel",
    row: chatRow,
    rootEventId: "evt_chat_root",
    rootBody: "chat-root",
    replyBody: "chat-reply-hidden",
    expectedScope: "channel",
  },
  {
    label: "project channel",
    row: projectRow,
    rootEventId: "evt_proj_root",
    rootBody: "project-root",
    replyBody: "project-reply-hidden",
    expectedScope: "channel",
  },
  {
    label: "group DM",
    row: groupRow,
    rootEventId: "evt_group_root",
    rootBody: "group-root",
    replyBody: "group-reply-hidden",
    expectedScope: "channel",
  },
];

function wire(
  eventId: string,
  body: string,
  extras: Partial<ConversationMessageWire> = {},
): ConversationMessageWire {
  return {
    eventId,
    body,
    createdAt: extras.createdAt ?? "2026-08-17T01:00:00.000Z",
    fromDisplayName: extras.fromDisplayName ?? "Ada",
    ...extras,
  };
}

function seedPair(
  rootEventId: string,
  rootBody: string,
  replyEventId: string,
  replyBody: string,
): {
  messages: ConversationMessageWire[];
  thread: {
    root: ConversationMessageWire;
    replies: ConversationMessageWire[];
  };
} {
  const root = wire(rootEventId, rootBody, {
    replyCount: 1,
    createdAt: "2026-08-17T01:00:00.000Z",
  });
  const reply = wire(replyEventId, replyBody, {
    rootEventId,
    fromDisplayName: "Bea",
    createdAt: "2026-08-17T01:05:00.000Z",
  });
  return { messages: [reply, root], thread: { root, replies: [reply] } };
}

function overfetchFirstPage(): ConversationMessageWire[] {
  const replies: ConversationMessageWire[] = [];
  const roots: ConversationMessageWire[] = [];
  for (let i = 0; i < 10; i++) {
    roots.push(
      wire(`evt_of_root_${i}`, `overfetch-root-${i}`, {
        replyCount: 4,
        createdAt: new Date(Date.UTC(2026, 7, 17, 1, i, 0)).toISOString(),
      }),
    );
  }
  for (let i = 0; i < 40; i++) {
    const rootIndex = i % 10;
    replies.push(
      wire(`evt_of_reply_${i}`, `overfetch-reply-${i}`, {
        rootEventId: `evt_of_root_${rootIndex}`,
        fromDisplayName: "Bea",
        createdAt: new Date(Date.UTC(2026, 7, 17, 3, 0, i)).toISOString(),
      }),
    );
  }
  // Newest-first hq-pro page: replies (newer) then roots.
  return [...replies, ...roots];
}

/**
 * Mutable fake direct hq-pro backend at https://hqapi.test. Handles the
 * list + GET /threads + POST-with-rootEventId routes this story exercises;
 * anything else 404s so an unexpected fetch fails loudly.
 */
function makeBackend() {
  const dm = seedPair(
    "evt_dm_root",
    "dm-root",
    "evt_dm_reply",
    "dm-reply-hidden",
  );
  const chat = seedPair(
    "evt_chat_root",
    "chat-root",
    "evt_chat_reply",
    "chat-reply-hidden",
  );
  const project = seedPair(
    "evt_proj_root",
    "project-root",
    "evt_proj_reply",
    "project-reply-hidden",
  );
  const group = seedPair(
    "evt_group_root",
    "group-root",
    "evt_group_reply",
    "group-reply-hidden",
  );

  const lists: Record<string, ConversationMessageWire[]> = {
    "dm:prs_ada": dm.messages,
    "ch:chn_chat": chat.messages,
    "ch:chn_proj": project.messages,
    "ch:chn_group": group.messages,
  };
  const threads: Record<
    string,
    {
      scope: "dm" | "channel";
      root: ConversationMessageWire;
      replies: ConversationMessageWire[];
    }
  > = {
    evt_dm_root: { scope: "dm", ...dm.thread },
    evt_chat_root: { scope: "channel", ...chat.thread },
    evt_proj_root: { scope: "channel", ...project.thread },
    evt_group_root: { scope: "channel", ...group.thread },
  };
  const overfetchPages: Record<
    string,
    { messages: ConversationMessageWire[]; nextCursor: string | null }
  > = {
    "": {
      messages: overfetchFirstPage(),
      nextCursor: OVERFETCH_CURSOR,
    },
    [OVERFETCH_CURSOR]: { messages: [], nextCursor: null },
  };

  const calls: { method: string; path: string; body: unknown }[] = [];
  let sendSeq = 0;

  function bumpRoot(
    messages: ConversationMessageWire[],
    rootEventId: string,
  ): void {
    const root = messages.find((row) => row.eventId === rootEventId);
    if (root) root.replyCount = (root.replyCount ?? 0) + 1;
  }

  function appendReply(
    listKey: string,
    rootEventId: string,
    body: string,
    fromDisplayName: string,
  ): ConversationMessageWire {
    const eventId = `evt_sent_${++sendSeq}`;
    const reply = wire(eventId, body, {
      rootEventId,
      fromDisplayName,
      createdAt: "2026-08-17T01:20:00.000Z",
    });
    const list = lists[listKey];
    if (list) {
      list.unshift(reply);
      bumpRoot(list, rootEventId);
    }
    const thread = threads[rootEventId];
    if (thread) {
      thread.replies.push(reply);
      thread.root = { ...thread.root, replyCount: thread.replies.length };
    }
    return reply;
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = hrefOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(href, "http://localhost");
    const path = `${url.pathname}${url.search}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    if (url.pathname === "/v1/notify/notifications") {
      return jsonResponse({
        notifications: [],
        unreadCount: 0,
        nextCursor: null,
      });
    }
    if (url.pathname === "/v1/work-mesh/threads") {
      return jsonResponse({ messages: [] });
    }
    if (url.pathname === "/v1/work-mesh/work") {
      return jsonResponse({ contractVersion: 2, snapshot: true, items: [] });
    }
    if (url.pathname === "/v1/notify/dm" && method === "GET") {
      return jsonResponse({});
    }
    if (url.pathname === "/v1/notify/threads") {
      const rootEventId = url.searchParams.get("rootEventId") ?? "";
      const scope = url.searchParams.get("scope");
      const thread = threads[rootEventId];
      if (!thread || (scope && scope !== thread.scope)) {
        return jsonResponse(
          { error: "THREAD_NOT_FOUND", code: "THREAD_NOT_FOUND" },
          404,
        );
      }
      return jsonResponse({
        scope: thread.scope,
        root: thread.root,
        replies: thread.replies,
        replyCount: thread.replies.length,
      });
    }
    if (url.pathname === "/v1/notify/thread") {
      const withPersonUid = url.searchParams.get("withPersonUid") ?? "";
      const messages = lists[`dm:${withPersonUid}`] ?? [];
      return jsonResponse({ messages, nextCursor: null });
    }
    const channelMessages = url.pathname.match(
      /^\/v1\/notify\/channels\/([^/]+)\/messages$/,
    );
    if (channelMessages && method === "GET") {
      const channelId = channelMessages[1]!;
      if (channelId === OVERFETCH_CHANNEL) {
        const cursor = url.searchParams.get("cursor") ?? "";
        const page = overfetchPages[cursor] ?? {
          messages: [],
          nextCursor: null,
        };
        return jsonResponse(page);
      }
      const messages = lists[`ch:${channelId}`] ?? [];
      return jsonResponse({ messages, nextCursor: null });
    }
    if (channelMessages && method === "POST") {
      const channelId = channelMessages[1]!;
      const rootEventId =
        typeof body?.rootEventId === "string" ? body.rootEventId.trim() : "";
      const text = typeof body?.body === "string" ? body.body : "";
      if (!rootEventId) {
        return jsonResponse({ eventId: `evt_top_${++sendSeq}` });
      }
      const reply = appendReply(`ch:${channelId}`, rootEventId, text, "You");
      return jsonResponse({ eventId: reply.eventId });
    }
    if (url.pathname === "/v1/notify/dm" && method === "POST") {
      const rootEventId =
        typeof body?.rootEventId === "string" ? body.rootEventId.trim() : "";
      const toPersonUid =
        typeof body?.toPersonUid === "string" ? body.toPersonUid.trim() : "";
      const text = typeof body?.body === "string" ? body.body : "";
      if (!rootEventId || !toPersonUid) {
        return jsonResponse({ error: "bad request" }, 400);
      }
      const reply = appendReply(`dm:${toPersonUid}`, rootEventId, text, "You");
      return jsonResponse({ eventId: reply.eventId });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    calls,
    fetchImpl,
    lists,
    threads,
    appendReply,
    seedWakeReply(rootEventId: string, reply: ConversationMessageWire) {
      const thread = threads[rootEventId];
      if (!thread) return;
      thread.replies.push(reply);
      thread.root = { ...thread.root, replyCount: thread.replies.length };
      const listKey =
        thread.scope === "dm" ? "dm:prs_ada" : `ch:${projectRow.channelId}`;
      const list = lists[listKey];
      if (list) {
        list.unshift(reply);
        bumpRoot(list, rootEventId);
      }
    },
  };
}

function makeApi(backend: ReturnType<typeof makeBackend>) {
  const adapter = new WebPlatformAdapter({
    baseUrl: "https://hqapi.test",
    fetch: backend.fetchImpl,
  });
  return createConversationApi(adapter);
}

/**
 * ConversationView.fetchWirePage + loadRoots: newest-first list through the
 * real adapter, then collectTimelineRoots (filters replies, over-fetches).
 */
async function loadTimeline(
  api: ReturnType<typeof createConversationApi>,
  row: ConversationRow,
): Promise<ConversationMessageWire[]> {
  const { roots } = await collectTimelineRoots({
    pageSize: TIMELINE_ROOT_PAGE_SIZE,
    fetchPage: async (cursor) => {
      if (row.kind === "dm" && row.personUid) {
        const resp = await api.fetchDmThread({
          withPersonUid: row.personUid,
          limit: TIMELINE_ROOT_PAGE_SIZE,
        });
        return { messages: resp.messages ?? [], nextCursor: null };
      }
      if (row.channelId) {
        const detail = await api.fetchChannel({
          channelId: row.channelId,
          limit: TIMELINE_ROOT_PAGE_SIZE,
          cursor,
        });
        return {
          messages: detail.messages ?? [],
          nextCursor: detail.nextCursor ?? null,
        };
      }
      return { messages: [], nextCursor: null };
    },
  });
  return [...roots].reverse().filter((item) => !isReplyMessage(item));
}

/** ReplyPanel open: “N replies” click → fetchReplyThread via replyScopeForRow. */
async function openReplyPanel(
  api: ReturnType<typeof createConversationApi>,
  row: ConversationRow,
  rootEventId: string,
): Promise<ReplyThreadResponse> {
  const scope = replyScopeForRow(row);
  if (scope === "channel") {
    return api.fetchReplyThread({
      scope: "channel",
      rootEventId,
      channelId: row.channelId,
    });
  }
  return api.fetchReplyThread({
    scope: "dm",
    rootEventId,
    withPersonUid: row.personUid,
  });
}

function makeMeshHarness(backend: ReturnType<typeof makeBackend>) {
  const wakes = createChatWakeBus();
  const mqttClients: FakeMqttClient[] = [];
  const mqttConnect: MqttConnectFn = () => {
    const client = new FakeMqttClient();
    mqttClients.push(client);
    return client;
  };
  const client = new MeshClient({
    credentialProvider: {
      fetchCredentials: () =>
        Promise.resolve({
          credentials: {
            accessKeyId: "AKIA_TEST",
            secretAccessKey: "test-secret",
            sessionToken: "test-token",
          },
          expiration: new Date(Date.now() + 3_600_000).toISOString(),
          iotEndpoint: "example-ats.iot.us-east-1.amazonaws.com",
          region: "us-east-1",
          personUid: "prs_bob",
          companyTopics: ["cmp_acme"],
          droppedCompanies: [],
        }),
    },
    fetcher: createHqReconcileFetcher(backend.fetchImpl),
    mqttConnect,
    random: () => 1,
    visibilityHost: null,
  });
  const replyWakes: ReplyNewWake[] = [];
  client.on("wake", (_topic, payloadText) => {
    routeMeshWake(payloadText, wakes);
  });
  client.on("reconciled", (result) => {
    routeMeshReconcile(result, wakes);
  });
  wakes.on("reply:new", (payload) => {
    replyWakes.push(payload);
  });
  return { client, mqttClients, wakes, replyWakes };
}

// ---------------------------------------------------------------------------
// US-006 story acceptance
// ---------------------------------------------------------------------------

describe("US-006: reply threads across DM, chat, project, and group DM", () => {
  it.each(CONVERSATIONS)(
    "Given a $label fixture with one reply, when the conversation opens, then the main timeline hides the reply and “1 reply” opens the panel",
    async (fixture) => {
      const backend = makeBackend();
      const api = makeApi(backend);

      const timeline = await loadTimeline(api, fixture.row);
      expect(timeline).toHaveLength(1);
      expect(timeline[0]?.eventId).toBe(fixture.rootEventId);
      expect(timeline[0]?.body).toBe(fixture.rootBody);
      expect(timeline[0]?.replyCount).toBe(1);
      expect(timeline.some((row) => row.body === fixture.replyBody)).toBe(
        false,
      );

      expect(replyScopeForRow(fixture.row)).toBe(fixture.expectedScope);

      const panel = await openReplyPanel(api, fixture.row, fixture.rootEventId);
      expect(panel.root?.eventId).toBe(fixture.rootEventId);
      expect(panel.root?.body).toBe(fixture.rootBody);
      expect(panel.replies).toHaveLength(1);
      expect(panel.replies[0]?.body).toBe(fixture.replyBody);
      expect(panel.replyCount).toBe(1);
      expect(panel.scope).toBe(fixture.expectedScope);

      const threadGets = backend.calls.filter(
        (call) =>
          call.method === "GET" &&
          call.path.startsWith("/v1/notify/threads"),
      );
      expect(threadGets).toHaveLength(1);
      expect(threadGets[0]?.path).toContain(
        "rootEventId=" + fixture.rootEventId,
      );
      expect(threadGets[0]?.path).toContain(`scope=${fixture.expectedScope}`);
      if (fixture.expectedScope === "channel") {
        expect(threadGets[0]?.path).toContain(
          `channelId=${fixture.row.channelId}`,
        );
      } else {
        expect(threadGets[0]?.path).toContain(
          `withPersonUid=${fixture.row.personUid}`,
        );
      }
      expect(
        backend.calls.some(
          (call) =>
            call.method === "GET" &&
            call.path.startsWith("/v1/notify/thread?") &&
            call.path.includes("rootEventId="),
        ),
      ).toBe(false);
    },
  );

  it("Given the project fixture, when a reply is sent from the panel, then the main timeline still shows only the root and the affordance increments", async () => {
    const backend = makeBackend();
    const api = makeApi(backend);

    const before = await loadTimeline(api, projectRow);
    expect(before.map((row) => row.eventId)).toEqual(["evt_proj_root"]);
    expect(before[0]?.replyCount).toBe(1);

    const panel = await openReplyPanel(api, projectRow, "evt_proj_root");
    expect(panel.replies.map((row) => row.body)).toEqual([
      "project-reply-hidden",
    ]);

    await api.sendReply({
      scope: "channel",
      rootEventId: "evt_proj_root",
      channelId: "chn_proj",
      body: "ok",
    });

    const post = backend.calls.find(
      (call) =>
        call.method === "POST" &&
        call.path === "/v1/notify/channels/chn_proj/messages",
    );
    expect(post?.body).toEqual({ body: "ok", rootEventId: "evt_proj_root" });

    const after = await loadTimeline(api, projectRow);
    expect(after).toHaveLength(1);
    expect(after[0]?.eventId).toBe("evt_proj_root");
    expect(after[0]?.body).toBe("project-root");
    expect(after[0]?.replyCount).toBe(2);
    expect(after.some((row) => row.body === "ok")).toBe(false);
    expect(after.some((row) => row.body === "project-reply-hidden")).toBe(
      false,
    );

    const refreshed = await openReplyPanel(api, projectRow, "evt_proj_root");
    expect(refreshed.replies.map((row) => row.body)).toEqual([
      "project-reply-hidden",
      "ok",
    ]);
    expect(refreshed.replyCount).toBe(2);
    expect(
      backend.calls.filter((call) =>
        call.path.startsWith("/v1/notify/threads"),
      ),
    ).toHaveLength(2);
  });

  it("a 50-row first page of 40 replies + 10 roots over-fetches and still shows those 10 roots", async () => {
    const backend = makeBackend();
    const api = makeApi(backend);
    const row: ConversationRow = {
      id: `ch:${OVERFETCH_CHANNEL}`,
      kind: "channel",
      title: "busy",
      companyUid: "cmp_acme",
      unreadDot: false,
      lastActivityAt: 0,
      pinned: false,
      channelId: OVERFETCH_CHANNEL,
    };

    const timeline = await loadTimeline(api, row);
    const listGets = backend.calls.filter(
      (call) =>
        call.method === "GET" &&
        call.path.includes(`/v1/notify/channels/${OVERFETCH_CHANNEL}/messages`),
    );
    expect(listGets.length).toBeGreaterThanOrEqual(2);
    expect(listGets[0]?.path.includes("cursor=")).toBe(false);
    expect(
      listGets.some((call) => call.path.includes(`cursor=${OVERFETCH_CURSOR}`)),
    ).toBe(true);

    expect(timeline).toHaveLength(10);
    expect(timeline.map((row) => row.eventId).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `evt_of_root_${i}`).sort(),
    );
    expect(
      timeline.every((row) => (row.body ?? "").startsWith("overfetch-root-")),
    ).toBe(true);
    expect(
      timeline.some((row) => (row.body ?? "").includes("overfetch-reply-")),
    ).toBe(false);
    expect(timeline.every((row) => !isReplyMessage(row))).toBe(true);
  });

  it("Given an open panel, when a type:thread wake fixture fires, then the new reply row appears", async () => {
    const backend = makeBackend();
    const api = makeApi(backend);
    const mesh = makeMeshHarness(backend);

    await mesh.client.start();
    await settle();
    mesh.mqttClients[0].fire("connect");
    await settle();
    expect(mesh.client.getConnectionState()).toBe("connected");

    const timeline = await loadTimeline(api, projectRow);
    expect(timeline).toHaveLength(1);
    let panel = await openReplyPanel(api, projectRow, "evt_proj_root");
    expect(panel.replies.map((row) => row.body)).toEqual([
      "project-reply-hidden",
    ]);

    mesh.wakes.on("reply:new", (payload) => {
      if (payload.rootEventId !== "evt_proj_root") return;
      void openReplyPanel(api, projectRow, payload.rootEventId).then((next) => {
        panel = next;
      });
    });

    const incoming = wire("evt_wake_open", "from B", {
      rootEventId: "evt_proj_root",
      fromDisplayName: "Bea",
      createdAt: "2026-08-17T01:30:00.000Z",
    });
    backend.seedWakeReply("evt_proj_root", incoming);

    const mqttBody = {
      type: "thread",
      scope: "channel",
      rootEventId: "evt_proj_root",
      eventId: "evt_wake_open",
      channelId: "chn_proj",
      createdAt: "2026-08-17T01:30:00.000Z",
      fromPersonUid: "prs_bea",
      body: "must-not-apply",
    };
    mesh.mqttClients[0].fire(
      "message",
      "hq/prs_bob/dm",
      new TextEncoder().encode(JSON.stringify(mqttBody)),
    );

    await waitFor(() => panel.replies.some((row) => row.body === "from B"));
    expect(panel.replies.map((row) => row.body)).toEqual([
      "project-reply-hidden",
      "from B",
    ]);
    expect(panel.replyCount).toBe(2);
    expect(mesh.replyWakes).toEqual([
      {
        rootEventId: "evt_proj_root",
        eventId: "evt_wake_open",
        scope: "channel",
        channelId: "chn_proj",
      },
    ]);
    expect(JSON.stringify(mesh.replyWakes[0])).not.toContain("must-not-apply");
    expect(
      backend.calls.some((call) =>
        call.path.startsWith("/v1/notify/threads?"),
      ),
    ).toBe(true);
    expect(
      backend.calls.filter(
        (call) =>
          call.method === "GET" &&
          call.path.includes("/v1/notify/channels/chn_proj/messages"),
      ),
    ).toHaveLength(1);

    mesh.client.stop();
  });

  it("a type:thread wake bumps replyCount when the panel is closed but the conversation is open", async () => {
    const backend = makeBackend();
    const api = makeApi(backend);
    const mesh = makeMeshHarness(backend);

    await mesh.client.start();
    await settle();
    mesh.mqttClients[0].fire("connect");
    await settle();

    const timeline = await loadTimeline(api, projectRow);
    expect(timeline[0]?.replyCount).toBe(1);

    backend.seedWakeReply(
      "evt_proj_root",
      wire("evt_wake_closed", "from B", {
        rootEventId: "evt_proj_root",
        fromDisplayName: "Bea",
        createdAt: "2026-08-17T01:30:00.000Z",
      }),
    );
    mesh.mqttClients[0].fire(
      "message",
      "hq/prs_bob/dm",
      new TextEncoder().encode(
        JSON.stringify({
          type: "thread",
          scope: "channel",
          rootEventId: "evt_proj_root",
          eventId: "evt_wake_closed",
          channelId: "chn_proj",
          body: "from B",
        }),
      ),
    );

    await waitFor(() => mesh.replyWakes[0]?.eventId === "evt_wake_closed");
    expect(replyNewMatchesConversation(mesh.replyWakes[0]!, projectRow)).toBe(
      true,
    );
    const bumped = bumpRootReplyCount(
      timeline,
      mesh.replyWakes[0]!.rootEventId,
    );
    expect(bumped).toHaveLength(1);
    expect(bumped[0]?.eventId).toBe("evt_proj_root");
    expect(bumped[0]?.replyCount).toBe(2);
    expect(bumped[0]?.body).toBe("project-root");
    expect(bumped.some((row) => row.body === "from B")).toBe(false);
    expect(JSON.stringify(mesh.replyWakes[0])).not.toContain("from B");
    expect(mesh.replyWakes).toHaveLength(1);
    expect(
      backend.calls.filter((call) => call.path.includes("/v1/notify/threads")),
    ).toHaveLength(0);

    mesh.client.stop();
  });

  it("fixtures contain no live secrets or work.hq.computer hosts", () => {
    const backend = makeBackend();
    const snapshot = JSON.stringify({
      lists: backend.lists,
      threads: backend.threads,
    });
    expect(snapshot).not.toMatch(/work\.hq\.computer/);
    expect(snapshot).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(snapshot).not.toMatch(/sk_live|aws_secret|CognitoIdentity/);
  });
});
