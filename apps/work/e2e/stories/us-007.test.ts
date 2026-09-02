/**
 * US-007 story acceptance tests (from PRD e2eTests):
 *
 * 1. Given two signed-in users, when user A sends a DM, then user B's inbox
 *    updates via wake without a manual refresh.
 * 2. Given a channel with history, when the conversation view opens, then
 *    messages render from REST and a new message arrives via wake.
 *
 * The deployed signed-in browser run is blocked (Cognito work-web client
 * prod deploy queued), so — per the US-005/US-004 story-test convention —
 * these run under vitest and drive the REAL seam wiring the chat page uses:
 *
 *   WebPlatformAdapter (real HTTP plumbing, mocked network)
 *     → $lib/chat-adapter bridges (real)
 *       → packages/ui models: notifications-model, channel-directory
 *         reconciler, chat wake bus (real)
 *   MeshClient (real wake→REST-reconcile core; mocked MQTT transport)
 *     → the same `reconciled`-event routing +page.svelte performs
 *       (notifications:* → wakeSeq bump → inbox refetch; dm:* → wakeBus
 *        "dm:pair-unreads"; everything else → wakeBus
 *        "channel:unread-changed" → directory reconcile).
 *
 * Only the network (fetch) and the MQTT socket are fakes; every model,
 * bridge, adapter, and reconcile code path is the production one. Runs under
 * `pnpm test` via apps/web/vitest.config.ts (Playwright's smoke project
 * ignores e2e/stories).
 */

import { describe, expect, it } from "vitest";

import { MeshClient, type MqttConnectFn } from "@hq/core";
import { WebPlatformAdapter } from "@hq/platform";
// Deep pure-TS module imports (the @hq/ui root entry re-exports .svelte
// components, which plain node vitest cannot compile).
import {
  createChatWakeBus,
  type ChatWakeEventName,
} from "../../../../packages/ui/src/chat/chat-api";
import {
  createChannelDirectoryReconciler,
  type ChannelDirectoryFeed,
  type ChannelDirectoryRow,
} from "../../../../packages/ui/src/chat/channel-directory-reconciler";
import {
  emptyFeedState,
  parseNotificationsResponse,
  reduceFeedLoaded,
  type NotificationsFeedState,
} from "../../../../packages/ui/src/inbox/notifications-model";
import {
  createChatSidebarApi,
  createNotificationsApi,
  resetLiveRailHydrate,
} from "../../src/lib/chat-adapter";

// ---------------------------------------------------------------------------
// Deterministic seams — mocked network + mocked MQTT transport only
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

/** Hop macrotasks (bounded) until `cond` holds — robust under parallel load. */
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Cursor tokens must satisfy the reconciler's base64url 32–128 shape. */
const CURSOR_1 = "a".repeat(40);
const CURSOR_2 = "b".repeat(40);
const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString();

interface WireNotification {
  id: string;
  type: string;
  status: "unread" | "read";
  createdAt: string;
  actorName: string;
  body: string;
}

/**
 * Mutable fake direct hq-pro backend at https://hqapi.test. Handles
 * exactly the routes this story exercises; anything else 404s so an
 * unexpected fetch fails loudly instead of passing vacuously.
 */
function makeBackend() {
  const notifications: WireNotification[] = [];
  const threadMessages: Record<string, string[]> = {};
  let directorySnapshot: ChannelDirectoryRow[] = [];
  let directoryDelta: ChannelDirectoryRow[] = [];
  const calls: string[] = [];

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://hqapi.test/v1/notify/notifications")) {
      return jsonResponse({
        notifications,
        unreadCount: notifications.filter((n) => n.status === "unread").length,
        nextCursor: null,
      });
    }
    const pathname = new URL(url, "http://localhost").pathname;
    // Real WebPlatformAdapter lists the rail at GET /v1/notify/channels.
    // Keep the older /v1/messaging/channel-directory path so a cursor
    // reconcile still works if the adapter pages that way.
    if (
      pathname === "/v1/notify/channels" ||
      pathname === "/v1/messaging/channel-directory"
    ) {
      const cursor = new URL(url, "http://localhost").searchParams.get(
        "cursor",
      );
      const feed: ChannelDirectoryFeed = cursor
        ? {
            contractVersion: 2,
            snapshot: false,
            cursor: CURSOR_2,
            cursorExpiresAt: FUTURE,
            changed: directoryDelta,
            removedChannelIds: [],
          }
        : {
            contractVersion: 2,
            snapshot: true,
            cursor: CURSOR_1,
            cursorExpiresAt: FUTURE,
            rows: directorySnapshot,
          };
      return jsonResponse(feed);
    }
    const thread = url.match(
      /^https:\/\/hqapi\.test\/v1\/work-mesh\/companies\/[^/]+\/threads\/(.+)$/,
    );
    if (thread) {
      return jsonResponse({ messages: threadMessages[thread[1]] ?? [] });
    }
    if (url.startsWith("https://hqapi.test/v1/notify/dm")) {
      return jsonResponse({});
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    notifications,
    threadMessages,
    calls,
    fetchImpl,
    setDirectory(
      snapshot: ChannelDirectoryRow[],
      delta: ChannelDirectoryRow[],
    ) {
      directorySnapshot = snapshot;
      directoryDelta = delta;
    },
  };
}

// ---------------------------------------------------------------------------
// Story harness — the exact wiring of routes/(app)/chat/+page.svelte
// ---------------------------------------------------------------------------

function makeStoryHarness(personUid: string) {
  resetLiveRailHydrate();
  const backend = makeBackend();

  // Real adapter + real bridges (as the page constructs them).
  const adapter = new WebPlatformAdapter({
    baseUrl: "https://hqapi.test",
    fetch: backend.fetchImpl,
  });
  const notificationsApi = createNotificationsApi(adapter);
  const sidebarApi = createChatSidebarApi(adapter);
  const wakeBus = createChatWakeBus();

  // Inbox state — the NotificationsView loadFeed path, minus Svelte
  // rendering: same api call shape, same parse + reduce model functions.
  let feedState: NotificationsFeedState = emptyFeedState();
  let notifWakeSeq = 0;
  let notifLoads = 0;
  async function loadNotifications(): Promise<void> {
    notifLoads++;
    const raw = await notificationsApi.fetchNotifications({
      limit: 50,
      cursor: null,
      unreadOnly: false,
    });
    feedState = reduceFeedLoaded(feedState, parseNotificationsResponse(raw));
  }

  // Sidebar/conversation state via the real directory reconciler.
  let rows: ChannelDirectoryRow[] = [];
  const reconciler = createChannelDirectoryReconciler({
    fetchFeed: (cursor) => sidebarApi.fetchChannelDirectory(cursor ?? null),
    onApply: (next) => {
      rows = next;
    },
  });
  const wakeBusEvents: ChatWakeEventName[] = [];
  wakeBus.on("channel:unread-changed", () => {
    wakeBusEvents.push("channel:unread-changed");
    // hydrateLiveRail caches the first snapshot; a wake must see the
    // durable REST update, not the in-memory first page.
    resetLiveRailHydrate();
    void reconciler.reconcile("wake");
  });

  // Real MeshClient over a fake socket; fetcher is the page's fetcher
  // (REST re-fetch goes straight to the hq-pro origin).
  const mqttClients: FakeMqttClient[] = [];
  const mqttConnect: MqttConnectFn = () => {
    const c = new FakeMqttClient();
    mqttClients.push(c);
    return c;
  };
  const reconciledThreads: unknown[] = [];
  const client = new MeshClient({
    credentialProvider: {
      fetchCredentials: () =>
        Promise.resolve({
          credentials: {
            accessKeyId: "AKIA1",
            secretAccessKey: "secret1",
            sessionToken: "token1",
          },
          expiration: new Date(Date.now() + 3_600_000).toISOString(),
          iotEndpoint: "example-ats.iot.us-east-1.amazonaws.com",
          region: "us-east-1",
          personUid,
          companyTopics: ["cmp_acme"],
          droppedCompanies: [],
        }),
    },
    fetcher: async (route) => {
      const res = await backend.fetchImpl(`https://hqapi.test${route.path}`);
      if (!res.ok) {
        throw new Error(`reconcile ${route.path} failed (${res.status})`);
      }
      return { state: await res.json().catch(() => null) };
    },
    mqttConnect,
    random: () => 1,
    visibilityHost: null,
  });
  // The page's reconciled-event routing, verbatim (plus thread-state capture
  // so the test can assert the REST-sourced conversation messages).
  client.on("reconciled", (result) => {
    if (result.resource.startsWith("notifications:")) {
      notifWakeSeq += 1;
      // NotificationsView's $effect: a wakeSeq bump re-fetches the feed.
      void loadNotifications();
      return;
    }
    if (result.resource.startsWith("dm:")) {
      // DM reconcile: fan the REST rollup (absent-safe) to the sidebar's
      // pair unreads and any open DM conversation.
      wakeBus.emit(
        "dm:pair-unreads",
        (result.state ?? {}) as { pairUnreads?: never[] },
      );
      return;
    }
    if (result.resource.startsWith("thread:")) {
      reconciledThreads.push(result.state);
    }
    wakeBus.emit("channel:unread-changed", undefined);
  });

  return {
    backend,
    client,
    mqttClients,
    reconciler,
    wakeBusEvents,
    reconciledThreads,
    loadNotifications,
    getFeedState: () => feedState,
    getRows: () => rows,
    getNotifWakeSeq: () => notifWakeSeq,
    getNotifLoads: () => notifLoads,
  };
}

// ---------------------------------------------------------------------------
// US-007 story acceptance
// ---------------------------------------------------------------------------

describe("US-007: chat shell + wake-driven inbox", () => {
  it("when user A sends a DM, user B's inbox updates via wake without a manual refresh", async () => {
    const bob = makeStoryHarness("prs_bob");
    await bob.client.start();
    await settle();
    bob.mqttClients[0].fire("connect");
    await settle();
    expect(bob.client.getConnectionState()).toBe("connected");
    // Connect-time catch-up settled; Bob's inbox is empty.
    await waitFor(() => bob.getNotifWakeSeq() >= 1);
    await waitFor(() => bob.getFeedState().items.length === 0);
    const loadsBeforeDm = bob.getNotifLoads();

    // User A (Ada) sends Bob a DM: the durable notification lands in the
    // NOTIF store server-side, then a wake is published on Bob's
    // notifications topic. The wake payload is advisory-only.
    bob.backend.notifications.push({
      id: "ntf_1",
      type: "dm_received",
      status: "unread",
      createdAt: new Date().toISOString(),
      actorName: "Ada",
      body: "hey Bob — got a sec?",
    });
    bob.mqttClients[0].fire(
      "message",
      "hq/prs_bob/notifications",
      new TextEncoder().encode('{"advisory":"never applied as state"}'),
    );

    // No manual refresh: the ONLY driver from here is the wake→reconcile
    // path (wakeSeq bump → view refetch).
    await waitFor(() => bob.getFeedState().items.length === 1);
    const item = bob.getFeedState().items[0];
    expect(item.displayKind).toBe("dm_received");
    expect(item.actorName).toBe("Ada");
    expect(item.status).toBe("unread");
    expect(item.contextLine).toBe("hey Bob — got a sec?");
    expect(bob.getFeedState().unreadCount).toBe(1);
    // Exactly one additional feed load, and it was wake-driven.
    expect(bob.getNotifLoads()).toBe(loadsBeforeDm + 1);
    // The item content came from REST, never from the MQTT payload.
    expect(JSON.stringify(bob.getFeedState())).not.toContain("advisory");
  });

  it("a channel with history renders messages from REST on open, and a new message arrives via wake", async () => {
    const bob = makeStoryHarness("prs_bob");
    const history: ChannelDirectoryRow = {
      channelId: "chn_general",
      type: "chat",
      scope: "company",
      companyUid: "cmp_acme",
      name: "general",
      lastActivityAt: "2026-08-14T10:00:00.000Z",
      unreadCount: 0,
    };
    bob.backend.setDirectory([history], []);
    bob.backend.threadMessages["chn_general"] = ["hello", "world"];

    await bob.client.start();
    await settle();
    bob.mqttClients[0].fire("connect");
    await settle();
    // Connect-time catch-up reconciles (incl. the thread/# wildcard) have
    // settled; clear captures so assertions isolate the open + the wake.
    await waitFor(() => bob.reconciler.status() !== "reconciling");
    bob.reconciledThreads.length = 0;
    bob.wakeBusEvents.length = 0;

    // Opening the conversation view runs the initial directory reconcile —
    // rows (and their message metadata) come from the REST snapshot.
    await bob.reconciler.reconcile("initial");
    expect(bob.getRows()).toHaveLength(1);
    expect(bob.getRows()[0]).toMatchObject({
      channelId: "chn_general",
      name: "general",
      lastActivityAt: "2026-08-14T10:00:00.000Z",
      unreadCount: 0,
    });

    // A new message lands server-side: the thread grows, the directory
    // delta reflects the new activity, and a wake fires on the thread topic.
    bob.backend.threadMessages["chn_general"] = ["hello", "world", "ping"];
    const updated: ChannelDirectoryRow = {
      ...history,
      lastActivityAt: "2026-08-14T10:05:00.000Z",
      unreadCount: 1,
    };
    // Durable server snapshot + delta both reflect the new message. The
    // live rail reads GET /v1/notify/channels (snapshot rows).
    bob.backend.setDirectory([updated], [updated]);
    bob.mqttClients[0].fire(
      "message",
      "hq/cmp_acme/thread/chn_general",
      new TextEncoder().encode('{"advisory":"wake only"}'),
    );

    // Wake → MeshClient re-fetches the thread from REST → page routing emits
    // channel:unread-changed → directory reconciler delta-fetches.
    await waitFor(() => (bob.getRows()[0]?.unreadCount ?? 0) === 1);
    expect(bob.wakeBusEvents).toContain("channel:unread-changed");
    // The thread's durable messages were re-fetched from REST (including
    // the new one) — the wake payload itself was never applied as state.
    expect(bob.reconciledThreads).toEqual([
      { messages: ["hello", "world", "ping"] },
    ]);
    expect(bob.getRows()[0].lastActivityAt).toBe("2026-08-14T10:05:00.000Z");
    // Wake re-hydrated the rail from GET /v1/notify/channels (live adapter
    // path), not the retired /v1/messaging/channel-directory cursor URL.
    expect(
      bob.backend.calls.filter((u) =>
        u.startsWith("https://hqapi.test/v1/notify/channels"),
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      bob.backend.calls.some((u) =>
        u.includes("/v1/work-mesh/companies/cmp_acme/threads/chn_general"),
      ),
    ).toBe(true);
    expect(JSON.stringify(bob.getRows())).not.toContain("advisory");
  });
});
