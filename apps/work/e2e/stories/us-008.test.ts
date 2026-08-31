/**
 * US-008 story acceptance tests (from PRD e2eTests):
 *
 * 1. Given an active work-mesh thread, when its status changes server-side,
 *    then the Board reflects the change via wake without refresh.
 * 2. Given a user in more companies than the credential policy budget allows,
 *    when the Board loads, then the dropped companies are visibly flagged.
 *
 * Plus US-008 coverage the PRD implies:
 * 3. A retained THREAD_META snapshot replayed on subscribe hydrates a late
 *    subscriber (thread appears with no prior rollup knowledge).
 * 4. The work-session feed polls until the FIRST work-session wake is
 *    observed, then flips permanently to wake-driven (feature-detected).
 *
 * Per the US-007 story-test convention these run under vitest and drive the
 * REAL seam wiring routes/(app)/board/+page.svelte uses:
 *
 *   WebPlatformAdapter (real HTTP plumbing, mocked network)
 *     → $lib/board-adapter createBoardDataApi (real)
 *       → packages/ui board models: thread-model normalization/upsert,
 *         company-scopes, work-session-feed, board wake bus (real)
 *   MeshClient (real wake→REST-reconcile core; mocked MQTT transport)
 *     → the SHARED board-reconcile routing the board page consumes
 *       (applyBoardReconcile: thread:* → normalizeThread + upsertThread,
 *       work:* → rollup state applied directly from the reconcile;
 *       isWorkSessionTopic → sessionFeed.wake();
 *       droppedCompanies → buildCompanyScopes).
 *
 * Only the network (fetch), the MQTT socket, and the feed's timer host are
 * fakes; every model, adapter, and reconcile code path is the production one.
 * Runs under `pnpm test` via apps/web/vitest.config.ts (Playwright's smoke
 * project ignores e2e/stories).
 */

import { describe, expect, it } from "vitest";

import { MeshClient, type MqttConnectFn } from "@hq/core";
import { WebPlatformAdapter } from "@hq/platform";
// Deep pure-TS module imports (the @hq/ui root entry re-exports .svelte
// components, which plain node vitest cannot compile).
import { createBoardWakeBus } from "../../../../packages/ui/src/board/board-api";
import {
  applyBoardReconcile,
  isWorkSessionTopic,
} from "../../../../packages/ui/src/board/board-reconcile";
import {
  buildCompanyScopes,
  type CompanyBoardScope,
  type WorkspaceMembershipInput,
} from "../../../../packages/ui/src/board/company-scopes";
import {
  threadsForCompany,
  type WorkMeshThread,
} from "../../../../packages/ui/src/board/thread-model";
import {
  createWorkSessionFeed,
  type FeedTimerHost,
  type WorkSessionFeed,
} from "../../../../packages/ui/src/board/work-session-feed";
import { createBoardDataApi } from "../../src/lib/board-adapter";

// ---------------------------------------------------------------------------
// Deterministic seams — mocked network, MQTT transport, and feed timers only
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

/** Manual fake timer host so poll intervals are deterministic (no real time). */
function makeFakeTimers(): FeedTimerHost & { tick(): void; active(): number } {
  const intervals = new Map<number, () => void>();
  let nextId = 1;
  return {
    setInterval(fn: () => void) {
      const id = nextId++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval(handle: unknown) {
      intervals.delete(handle as number);
    },
    tick() {
      for (const fn of [...intervals.values()]) fn();
    },
    active() {
      return intervals.size;
    },
  };
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

interface WireThread {
  threadId: string;
  companyUid: string;
  project: string;
  title: string;
  status: string;
  updatedAt: string;
  note?: string;
}

/**
 * Mutable direct hq-pro work-mesh backend at https://hqapi.test.
 * Handles exactly the routes this story exercises; anything else 404s. The
 * work-sessions route 404s until enabled — the exact absent-safe posture the
 * adapter promises ([] until US-009 lands).
 */
function makeBackend() {
  const threadsByKey = new Map<string, WireThread>();
  let sessions: unknown[] | null = null; // null → 404 (API not shipped)
  const calls: string[] = [];

  const fetchImpl = (async (input: RequestInfo | URL) => {
    // BoardDataApi supplies API-relative paths to the authenticated direct
    // client; the adapter supplies absolute ones. Model both at the direct
    // hq-pro origin so this fake never revives the deleted same-origin proxy.
    const url = new URL(String(input), "https://hqapi.test").toString();
    calls.push(url);
    if (url.startsWith("https://hqapi.test/v1/work-mesh/threads")) {
      return jsonResponse({ threads: [...threadsByKey.values()] });
    }
    if (
      url === "https://hqapi.test/v1/work-mesh/work" ||
      url.startsWith("https://hqapi.test/v1/work-mesh/work?")
    ) {
      return jsonResponse({ contractVersion: 2, snapshot: true, items: [] });
    }
    const thread = url.match(
      /^https:\/\/hqapi\.test\/v1\/work-mesh\/companies\/([^/]+)\/threads\/(.+)$/,
    );
    if (thread) {
      const key = `${decodeURIComponent(thread[1])}:${thread[2]
        .split("/")
        .map(decodeURIComponent)
        .join("/")}`;
      const t = threadsByKey.get(key);
      return t
        ? jsonResponse({ thread: t })
        : new Response("nf", { status: 404 });
    }
    if (url.startsWith("https://hqapi.test/v1/work-mesh/work-sessions")) {
      return sessions == null
        ? new Response("nf", { status: 404 })
        : jsonResponse({ sessions });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;

  return {
    calls,
    fetchImpl,
    setThread(t: WireThread) {
      threadsByKey.set(`${t.companyUid}:${t.threadId}`, t);
    },
    setSessions(next: unknown[] | null) {
      sessions = next;
    },
    countCalls(fragment: string): number {
      return calls.filter((u) => u.includes(fragment)).length;
    },
  };
}

// ---------------------------------------------------------------------------
// Story harness — the exact wiring of routes/(app)/board/+page.svelte
// ---------------------------------------------------------------------------

interface HarnessOptions {
  droppedCompanies?: string[];
  workspaces?: WorkspaceMembershipInput[];
}

function makeStoryHarness(personUid: string, opts: HarnessOptions = {}) {
  const backend = makeBackend();
  const timers = makeFakeTimers();

  // Real adapter + real board data api (as the page constructs them).
  const adapter = new WebPlatformAdapter({
    baseUrl: "https://hqapi.test",
    fetch: backend.fetchImpl,
  });
  const api = createBoardDataApi(adapter, backend.fetchImpl);
  const wakeBus = createBoardWakeBus();

  // Board state — the +page.svelte $state/$effect wiring, minus Svelte
  // rendering: same api calls, same model functions, same routing.
  let threads: WorkMeshThread[] = [];
  const workspaces = opts.workspaces ?? [];
  let droppedCompanies: string[] = [];
  let scopes: CompanyBoardScope[] = [];
  const recomputeScopes = (): void => {
    // The page's `$effect(() => { scopes = buildCompanyScopes(...) })`.
    scopes = buildCompanyScopes(workspaces, droppedCompanies);
  };
  recomputeScopes();

  let threadRefreshes = 0;
  async function refreshThreads(): Promise<void> {
    threadRefreshes++;
    threads = await api.listThreads();
  }

  let sessions: unknown[] = [];
  let sessionRefreshes = 0;
  async function refreshSessions(): Promise<void> {
    sessionRefreshes++;
    sessions = await api.listWorkSessions();
  }

  // Work sessions: poll → wake-driven flip (US-008 AC3 / US-009). The page
  // uses BOARD_POLL_MS with real timers; the timer host is the seam the feed
  // exposes for determinism.
  const sessionFeed: WorkSessionFeed = createWorkSessionFeed({
    refresh: refreshSessions,
    pollMs: 15_000,
    timers,
  });

  // Real MeshClient over a fake socket; fetcher is the page's fetcher
  // (REST re-fetch goes straight to the hq-pro origin).
  const mqttClients: FakeMqttClient[] = [];
  const mqttConnect: MqttConnectFn = () => {
    const c = new FakeMqttClient();
    mqttClients.push(c);
    return c;
  };
  const wakeBusEvents: string[] = [];
  wakeBus.on("thread:reconciled", () =>
    wakeBusEvents.push("thread:reconciled"),
  );
  wakeBus.on("work:reconciled", () => wakeBusEvents.push("work:reconciled"));
  wakeBus.on("work-session:wake", () =>
    wakeBusEvents.push("work-session:wake"),
  );
  wakeBus.on("dropped-companies", () =>
    wakeBusEvents.push("dropped-companies"),
  );

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
          droppedCompanies: opts.droppedCompanies ?? [],
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

  // The page's event routing, verbatim.
  client.on("droppedCompanies", (uids) => {
    droppedCompanies = uids;
    recomputeScopes();
    wakeBus.emit("dropped-companies", uids);
  });
  client.on("wake", (topic) => {
    // Feature detection for US-009: an exact hq/{uid}/work-session/... topic
    // (incl. retained replays) flips the session feed to wake-driven.
    if (isWorkSessionTopic(topic)) {
      wakeBus.emit("work-session:wake", undefined);
      sessionFeed.wake();
    }
  });
  client.on("reconciled", (result) => {
    // Shared routing (board-reconcile): thread:* upserts the per-thread
    // detail; work:* applies the reconciled rollup state directly (no
    // refetch — preserves WakeReconciler ordering/coalescing).
    const outcome = applyBoardReconcile(result, threads, wakeBus.emit);
    if (outcome.handled) threads = outcome.threads;
  });

  return {
    backend,
    client,
    mqttClients,
    timers,
    sessionFeed,
    wakeBusEvents,
    refreshThreads,
    getThreads: () => threads,
    getScopes: () => scopes,
    getSessions: () => sessions,
    getThreadRefreshes: () => threadRefreshes,
    getSessionRefreshes: () => sessionRefreshes,
  };
}

async function startConnected(
  h: ReturnType<typeof makeStoryHarness>,
): Promise<void> {
  await h.client.start();
  await settle();
  h.mqttClients[0].fire("connect");
  await settle();
  expect(h.client.getConnectionState()).toBe("connected");
}

// ---------------------------------------------------------------------------
// US-008 story acceptance
// ---------------------------------------------------------------------------

describe("US-008: work-mesh Board web port", () => {
  it("an active thread's server-side status change reaches the Board via wake, without refresh", async () => {
    const h = makeStoryHarness("prs_bob");
    h.backend.setThread({
      threadId: "T-1",
      companyUid: "cmp_acme",
      project: "v2-foundation",
      title: "US-008 board port",
      status: "progress",
      updatedAt: "2026-08-14T10:00:00.000Z",
    });

    // Board load: rollup fetch + connect (connect catch-up reconciles the
    // person-scoped work: rollup too).
    await h.refreshThreads();
    await startConnected(h);
    await waitFor(() => h.wakeBusEvents.includes("work:reconciled"));
    await waitFor(() =>
      h
        .getThreads()
        .some((t) => t.threadId === "T-1" && t.status === "progress"),
    );
    const rollupFetches = h.backend.countCalls("/v1/work-mesh/threads");
    const refreshesBefore = h.getThreadRefreshes();

    // The thread's status changes server-side; a wake fires on its topic.
    // The wake payload is advisory-only and must never be applied as state.
    h.backend.setThread({
      threadId: "T-1",
      companyUid: "cmp_acme",
      project: "v2-foundation",
      title: "US-008 board port",
      status: "blocked",
      updatedAt: "2026-08-14T10:05:00.000Z",
      note: "waiting on Cognito deploy",
    });
    h.mqttClients[0].fire(
      "message",
      "hq/cmp_acme/thread/T-1",
      new TextEncoder().encode('{"advisory":"status: done — never applied"}'),
    );

    // No manual refresh: the ONLY driver is wake → per-thread REST reconcile
    // → normalizeThread + upsertThread (rendered by ThreadList's
    // thread-status chip).
    await waitFor(() => h.getThreads()[0]?.status === "blocked");
    const row = threadsForCompany(h.getThreads(), "cmp_acme")[0];
    expect(row).toMatchObject({
      threadId: "T-1",
      companyUid: "cmp_acme",
      status: "blocked",
      note: "waiting on Cognito deploy",
      updatedAt: "2026-08-14T10:05:00.000Z",
    });
    // The change rode the per-thread resource — no full-rollup refresh ran.
    expect(h.getThreadRefreshes()).toBe(refreshesBefore);
    expect(h.backend.countCalls("/v1/work-mesh/threads")).toBe(rollupFetches);
    expect(
      h.backend.countCalls("/v1/work-mesh/companies/cmp_acme/threads/T-1"),
    ).toBe(1);
    // Advisory wake payload never leaked into applied state.
    expect(JSON.stringify(h.getThreads())).not.toContain("advisory");
  });

  it("companies dropped by the credential policy budget are visibly flagged, never hidden", async () => {
    const h = makeStoryHarness("prs_bob", {
      workspaces: [
        { companyUid: "cmp_acme", displayName: "Acme" },
        { companyUid: "cmp_beta", displayName: "Beta" },
        { companyUid: "cmp_big", displayName: "Big Co" },
      ],
      // The STS vend excluded cmp_big's thread topics (2048-char policy cap).
      droppedCompanies: ["cmp_big"],
    });

    // Before the vend lands, all sections render healthy.
    expect(h.getScopes().every((s) => !s.realtimeDropped)).toBe(true);

    await startConnected(h);
    await waitFor(() => h.wakeBusEvents.includes("dropped-companies"));

    // Every membership still renders — the dropped one is flagged (the page
    // renders scope.realtimeDropped as the company-realtime-degraded badge
    // plus the dropped-companies-banner) and sorts last so healthy boards
    // paint first. Never silently hidden.
    const scopes = h.getScopes();
    expect(scopes).toHaveLength(3);
    expect(scopes.map((s) => s.companyUid)).toEqual([
      "cmp_acme",
      "cmp_beta",
      "cmp_big",
    ]);
    expect(scopes.map((s) => s.realtimeDropped)).toEqual([false, false, true]);
    expect(scopes[2]).toMatchObject({ label: "Big Co", realtimeDropped: true });
  });

  it("a retained THREAD_META snapshot replayed on subscribe hydrates a late subscriber", async () => {
    const h = makeStoryHarness("prs_bob");
    // The thread's durable state exists server-side, but this late subscriber
    // has never seen it; hydration must ride the retained-wake path alone
    // (no additional rollup refresh).
    h.backend.setThread({
      threadId: "proj/alpha",
      companyUid: "cmp_acme",
      project: "alpha",
      title: "Alpha kickoff",
      status: "start",
      updatedAt: "2026-08-14T09:00:00.000Z",
    });

    await startConnected(h);
    // Connect catch-up (work: rollup) settled.
    await waitFor(() => h.wakeBusEvents.includes("work:reconciled"));
    const refreshesBefore = h.getThreadRefreshes();
    const detailFragment =
      "/v1/work-mesh/companies/cmp_acme/threads/proj/alpha";
    expect(h.backend.countCalls(detailFragment)).toBe(0);

    // The broker replays the retained THREAD_META message for the subscribed
    // hq/cmp_acme/thread/# filter. Retained or live, it is a wake signal
    // only — durable state comes from the per-thread REST resource.
    h.mqttClients[0].fire(
      "message",
      "hq/cmp_acme/thread/proj/alpha",
      new TextEncoder().encode('{"type":"THREAD_META","retain":true}'),
    );

    await waitFor(() =>
      h.getThreads().some((t) => t.threadId === "proj/alpha"),
    );
    expect(
      h.getThreads().find((t) => t.threadId === "proj/alpha"),
    ).toMatchObject({
      companyUid: "cmp_acme",
      project: "alpha",
      title: "Alpha kickoff",
      status: "start",
    });
    // Hydration used the per-thread resource (multi-segment id preserved),
    // not another rollup refresh.
    expect(h.backend.countCalls(detailFragment)).toBe(1);
    expect(h.getThreadRefreshes()).toBe(refreshesBefore);
  });

  it("the work-session feed polls until the first work-session wake, then flips permanently to wake-driven", async () => {
    const h = makeStoryHarness("prs_bob");
    await startConnected(h);

    // US-009's endpoint does not exist yet: the feed starts polling and each
    // tick resolves [] (absent-safe).
    h.sessionFeed.start();
    expect(h.sessionFeed.mode).toBe("polling");
    await waitFor(() => h.getSessionRefreshes() === 1);
    h.timers.tick();
    h.timers.tick();
    await waitFor(() => h.getSessionRefreshes() === 3);
    expect(h.getSessions()).toEqual([]);
    expect(h.timers.active()).toBe(1);

    // The wake channel is real: the MeshClient actually subscribed to the
    // person-scoped work-session filter — the feature-detect signal has a
    // live transport path, not a test-only injection.
    expect(h.mqttClients[0].subscribed.flat()).toContain(
      "hq/prs_bob/work-session/#",
    );

    // A thread topic whose id merely CONTAINS "/work-session" is NOT the
    // feature-detect signal — polling must survive it (segment parse, not
    // substring match).
    h.mqttClients[0].fire(
      "message",
      "hq/cmp_acme/thread/proj/work-session-notes",
      new TextEncoder().encode("{}"),
    );
    await settle();
    expect(h.sessionFeed.mode).toBe("polling");
    expect(h.timers.active()).toBe(1);

    // The backend ships work-session wakes: the first observed work-session
    // topic (a retained replay on subscribe counts) proves wake support.
    h.backend.setSessions([
      {
        project: "v2-foundation",
        company: "cmp_acme",
        cwd: "/repo",
        status: "running",
        storyId: "US-008",
      },
    ]);
    h.mqttClients[0].fire(
      "message",
      "hq/prs_bob/work-session/sess-1",
      new TextEncoder().encode('{"retain":true,"advisory":"wake only"}'),
    );

    // Feature-detected flip: poll timer stopped, mode wake-driven, and the
    // wake itself refreshed the records from REST.
    await waitFor(() => h.getSessions().length === 1);
    expect(h.getSessionRefreshes()).toBe(4);
    expect(h.sessionFeed.mode).toBe("wake-driven");
    expect(h.wakeBusEvents).toContain("work-session:wake");
    expect(h.timers.active()).toBe(0);
    expect(h.getSessions()).toEqual([
      {
        project: "v2-foundation",
        company: "cmp_acme",
        cwd: "/repo",
        status: "running",
        storyId: "US-008",
      },
    ]);

    // The flip is permanent: timer ticks can no longer drive refreshes;
    // subsequent wakes still do.
    h.timers.tick();
    await settle();
    expect(h.getSessionRefreshes()).toBe(4);
    h.mqttClients[0].fire(
      "message",
      "hq/prs_bob/work-session/sess-1",
      new TextEncoder().encode("{}"),
    );
    await waitFor(() => h.getSessionRefreshes() === 5);
    expect(h.sessionFeed.mode).toBe("wake-driven");
  });
});
