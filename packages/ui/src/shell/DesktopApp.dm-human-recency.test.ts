// @vitest-environment happy-dom

/**
 * 1:1 DM human recency comes from GET /v1/notify/dm-threads.
 *
 * A server that maintains it reports `lastHumanMessageAt` per pair, or
 * `hasHumanMessage: false` when the pair is known to hold no human message.
 * The shell passes those fields to the rail with the activity it already
 * emits. Because only the server computes the value, the shell reads the
 * listing again when a DM arrives or is sent, but only in human-only mode
 * and only for a server that has shown it reports the fields. An arriving DM
 * shares one read per interval, the person's own send is read at once, and a
 * response that is no longer the newest request's is dropped. An older
 * server keeps the single backfill read it had before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { InboxDmActivity } from "../chat/live-catchup.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import { takePendingChannelOpen } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

interface Fixture {
  threads: Array<Record<string, unknown>>;
  threadsCalls: number;
  /** Flag answer; `undefined` leaves the adapter without `hasFeature`. */
  humanOnly?: boolean;
  /**
   * When set, a listing read does not answer by itself: the test resolves
   * each one, in the order it chooses.
   */
  deferred?: Array<(threads: Array<Record<string, unknown>>) => void>;
}

function adapter(fx: Fixture): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [] }),
      fetchDmThread: async () => ok({ messages: [] }),
      sendDm: async () =>
        ok({ eventId: `evt_self_${Date.now()}`, createdAt: new Date().toISOString() }),
    },
    notifications: {
      fetchDmInbox: async () => ok({ events: [] }),
      fetchDmThreads: async () => {
        fx.threadsCalls += 1;
        if (fx.deferred) {
          const queue = fx.deferred;
          return new Promise((resolve) => {
            queue.push((threads) => resolve(ok({ threads })));
          });
        }
        return ok({ threads: fx.threads });
      },
    },
    ...(fx.humanOnly === undefined
      ? {}
      : {
          identity: {
            hasFeature: async () => ok(fx.humanOnly === true),
            subscribeFeature: () => () => {},
          },
        }),
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

const DM_ROW = {
  id: "dm:prs_ada",
  kind: "dm",
  title: "Ada",
  personUid: "prs_ada",
} as ConversationRow;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function resetSharedState(): void {
  window.localStorage?.clear?.();
  takePendingConversation();
  takePendingChannelOpen();
}

beforeEach(resetSharedState);

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetSharedState();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Type a message in the open conversation's composer and send it. */
function sendFromComposer(text: string): void {
  const composer = host.querySelector<HTMLTextAreaElement>(
    '[data-testid="conversation-composer"]',
  );
  expect(composer, "live composer is mounted").toBeTruthy();
  composer!.value = text;
  composer!.dispatchEvent(new Event("input", { bubbles: true }));
  composer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountApp(fx: Fixture, initialRow?: ConversationRow) {
  const wakes = createChatWakeBus();
  const activity: InboxDmActivity[][] = [];
  wakes.on("dm:pair-unreads", (payload) => {
    if (payload.activity) activity.push(payload.activity);
  });
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(fx),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      tenantAccountId: "acct_test",
      ...(initialRow ? { initialRow } : {}),
      wakes,
      coreFixtures: false,
    },
  });
  await settle(20);
  /** The newest emitted entry for one peer. */
  const latest = (uid: string): InboxDmActivity | undefined =>
    activity
      .flat()
      .filter((entry) => entry.personUid === uid)
      .at(-1);
  return { wakes, activity, latest };
}

const NEW_SERVER_THREADS = [
  {
    peerUid: "prs_ada",
    lastActivityAt: "2026-10-01T12:00:00.000Z",
    lastEventId: "e3",
    lastHumanMessageAt: "2026-09-30T09:00:00.000Z",
  },
  {
    peerUid: "agt_notices",
    lastActivityAt: "2026-10-01T11:00:00.000Z",
    lastEventId: "e2",
    hasHumanMessage: false,
  },
  { peerUid: "prs_unexamined", lastActivityAt: "2026-10-01T10:00:00.000Z", lastEventId: "e1" },
];

const OLD_SERVER_THREADS = [
  { peerUid: "prs_ada", lastActivityAt: "2026-10-01T12:00:00.000Z", lastEventId: "e3" },
];

describe("DesktopApp DM human recency from the thread listing", () => {
  it("passes the three states to the rail with the activity", async () => {
    const fx: Fixture = { threads: NEW_SERVER_THREADS, threadsCalls: 0 };
    const { latest } = await mountApp(fx);
    expect(latest("prs_ada")).toMatchObject({
      lastMessageAt: "2026-10-01T12:00:00.000Z",
      lastHumanMessageAt: "2026-09-30T09:00:00.000Z",
    });
    expect(latest("agt_notices")).toMatchObject({ hasHumanMessage: false });
    const unknown = latest("prs_unexamined");
    expect(unknown).toBeDefined();
    expect(unknown && "lastHumanMessageAt" in unknown).toBe(false);
    expect(unknown && "hasHumanMessage" in unknown).toBe(false);
  });

  it("a server that reports the fields is read again when a DM arrives, and the new time reaches the rail", async () => {
    const fx: Fixture = { threads: NEW_SERVER_THREADS, threadsCalls: 0 };
    const { wakes, latest } = await mountApp(fx);
    const before = fx.threadsCalls;
    expect(before).toBeGreaterThanOrEqual(1);

    fx.threads = [
      {
        ...NEW_SERVER_THREADS[0],
        lastActivityAt: "2026-10-01T13:00:00.000Z",
        lastHumanMessageAt: "2026-10-01T13:00:00.000Z",
      },
      ...NEW_SERVER_THREADS.slice(1),
    ];
    wakes.emit("dm:new-message", {
      fromPersonUid: "prs_ada",
      eventId: "evt_new",
      createdAt: "2026-10-01T13:00:00.000Z",
      direction: "in",
    });
    await vi.waitFor(() => expect(fx.threadsCalls).toBe(before + 1), {
      timeout: 3000,
    });
    await vi.waitFor(() =>
      expect(latest("prs_ada")).toMatchObject({
        lastHumanMessageAt: "2026-10-01T13:00:00.000Z",
      }),
    );
  });

  it("arriving DMs share one listing read per interval", async () => {
    const fx: Fixture = { threads: NEW_SERVER_THREADS, threadsCalls: 0 };
    const { wakes } = await mountApp(fx);
    const before = fx.threadsCalls;
    for (let i = 0; i < 4; i += 1) {
      wakes.emit("dm:new-message", {
        fromPersonUid: "prs_ada",
        eventId: `evt_${i}`,
        createdAt: `2026-10-01T13:00:0${i}.000Z`,
        direction: "in",
      });
    }
    await vi.waitFor(() => expect(fx.threadsCalls).toBe(before + 1), {
      timeout: 3000,
    });
    // The next one, inside the interval, waits for it.
    wakes.emit("dm:new-message", {
      fromPersonUid: "prs_ada",
      eventId: "evt_late",
      createdAt: "2026-10-01T13:05:00.000Z",
      direction: "in",
    });
    await wait(900);
    expect(fx.threadsCalls).toBe(before + 1);
  });

  it("a DM that arrives inside the interval gets its read once the interval has passed, one read for all of them", async () => {
    const fx: Fixture = { threads: NEW_SERVER_THREADS, threadsCalls: 0 };
    const { wakes, latest } = await mountApp(fx);
    const before = fx.threadsCalls;
    wakes.emit("dm:new-message", {
      fromPersonUid: "prs_ada",
      eventId: "evt_first",
      createdAt: "2026-10-01T13:00:00.000Z",
      direction: "in",
    });
    await vi.waitFor(() => expect(fx.threadsCalls).toBe(before + 1), {
      timeout: 3000,
    });

    // The first read has run, so the interval is open. From here the clock
    // is the test's: the fake clock starts at the real time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fx.threads = [
        {
          ...NEW_SERVER_THREADS[0],
          lastActivityAt: "2026-10-01T13:05:01.000Z",
          lastHumanMessageAt: "2026-10-01T13:05:01.000Z",
        },
        ...NEW_SERVER_THREADS.slice(1),
      ];
      for (let i = 0; i < 2; i += 1) {
        wakes.emit("dm:new-message", {
          fromPersonUid: "prs_ada",
          eventId: `evt_late_${i}`,
          createdAt: `2026-10-01T13:05:0${i}.000Z`,
          direction: "in",
        });
      }
      // Inside the 20 second interval: held back.
      await vi.advanceTimersByTimeAsync(18_000);
      expect(fx.threadsCalls).toBe(before + 1);
      // The interval has passed: the trailing read fires, once for both.
      await vi.advanceTimersByTimeAsync(2_500);
      expect(fx.threadsCalls).toBe(before + 2);
      await vi.advanceTimersByTimeAsync(0);
      expect(latest("prs_ada")).toMatchObject({
        lastHumanMessageAt: "2026-10-01T13:05:01.000Z",
      });
      // Nothing further follows without a new DM.
      await vi.advanceTimersByTimeAsync(45_000);
      expect(fx.threadsCalls).toBe(before + 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a server that reports the fields is read again after the person sends a DM", async () => {
    const fx: Fixture = { threads: NEW_SERVER_THREADS, threadsCalls: 0 };
    const { latest } = await mountApp(fx, DM_ROW);
    const before = fx.threadsCalls;

    fx.threads = [
      {
        ...NEW_SERVER_THREADS[0],
        lastActivityAt: "2026-10-01T14:00:00.000Z",
        lastHumanMessageAt: "2026-10-01T14:00:00.000Z",
      },
      ...NEW_SERVER_THREADS.slice(1),
    ];
    const composer = host.querySelector<HTMLTextAreaElement>(
      '[data-testid="conversation-composer"]',
    );
    expect(composer, "live composer is mounted").toBeTruthy();
    composer!.value = "hello Ada";
    composer!.dispatchEvent(new Event("input", { bubbles: true }));
    composer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(20);

    expect(fx.threadsCalls).toBe(before + 1);
    expect(latest("prs_ada")).toMatchObject({
      lastHumanMessageAt: "2026-10-01T14:00:00.000Z",
    });
  });

  it("an older server (no human fields) is not read again on a DM wake or a send", async () => {
    const fx: Fixture = { threads: OLD_SERVER_THREADS, threadsCalls: 0 };
    const { wakes, latest } = await mountApp(fx, DM_ROW);
    const before = fx.threadsCalls;
    expect(before).toBeGreaterThanOrEqual(1);
    const entry = latest("prs_ada");
    expect(entry && "lastHumanMessageAt" in entry).toBe(false);

    wakes.emit("dm:new-message", {
      fromPersonUid: "prs_ada",
      eventId: "evt_new",
      createdAt: "2026-10-01T13:00:00.000Z",
      direction: "in",
    });
    await settle(20);
    const composer = host.querySelector<HTMLTextAreaElement>(
      '[data-testid="conversation-composer"]',
    );
    composer!.value = "hello Ada";
    composer!.dispatchEvent(new Event("input", { bubbles: true }));
    composer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(20);

    expect(fx.threadsCalls).toBe(before);
  });

  it("the person's own sends are each read at once, not held back by the interval", async () => {
    const fx: Fixture = { threads: NEW_SERVER_THREADS, threadsCalls: 0 };
    await mountApp(fx, DM_ROW);
    const before = fx.threadsCalls;
    sendFromComposer("one");
    await settle(20);
    expect(fx.threadsCalls).toBe(before + 1);
    sendFromComposer("two");
    await settle(20);
    expect(fx.threadsCalls).toBe(before + 2);
    // And no extra, throttled read follows.
    await wait(900);
    expect(fx.threadsCalls).toBe(before + 2);
  });

  it("flag off: the listing is not read again on a DM wake or a send, even from a server that reports the fields", async () => {
    const fx: Fixture = {
      threads: NEW_SERVER_THREADS,
      threadsCalls: 0,
      humanOnly: false,
    };
    const { wakes } = await mountApp(fx, DM_ROW);
    const before = fx.threadsCalls;
    // The boot read that stamps older DM rows is not a human-recency read.
    expect(before).toBeGreaterThanOrEqual(1);

    wakes.emit("dm:new-message", {
      fromPersonUid: "prs_ada",
      eventId: "evt_new",
      createdAt: "2026-10-01T13:00:00.000Z",
      direction: "in",
    });
    sendFromComposer("hello Ada");
    await settle(20);
    await wait(900);
    expect(fx.threadsCalls).toBe(before);
  });

  it("two reads in flight: only the newest request's answer reaches the rail", async () => {
    const fx: Fixture = { threads: NEW_SERVER_THREADS, threadsCalls: 0 };
    const { latest } = await mountApp(fx, DM_ROW);
    expect(latest("prs_ada")).toMatchObject({
      lastHumanMessageAt: "2026-09-30T09:00:00.000Z",
    });
    const before = fx.threadsCalls;

    // From here each listing read waits for the test.
    fx.deferred = [];
    sendFromComposer("one");
    await settle(20);
    sendFromComposer("two");
    await settle(20);
    expect(fx.threadsCalls).toBe(before + 2);
    expect(fx.deferred).toHaveLength(2);
    const [answerFirst, answerSecond] = fx.deferred;

    const listing = (at: string) => [
      { ...NEW_SERVER_THREADS[0], lastActivityAt: at, lastHumanMessageAt: at },
      ...NEW_SERVER_THREADS.slice(1),
    ];
    // The second request's answer lands first, then the first request's,
    // which describes an older state of the pair.
    answerSecond(listing("2026-10-01T14:00:02.000Z"));
    await settle(10);
    expect(latest("prs_ada")).toMatchObject({
      lastHumanMessageAt: "2026-10-01T14:00:02.000Z",
    });
    answerFirst(listing("2026-10-01T14:00:01.000Z"));
    await settle(10);
    expect(latest("prs_ada")).toMatchObject({
      lastHumanMessageAt: "2026-10-01T14:00:02.000Z",
    });
  });
});
