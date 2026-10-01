// @vitest-environment happy-dom

/**
 * 1:1 DM human recency comes from GET /v1/notify/dm-threads.
 *
 * A server that maintains it reports `lastHumanMessageAt` per pair, or
 * `hasHumanMessage: false` when the pair is known to hold no human message.
 * The shell passes those fields to the rail with the activity it already
 * emits. Because only the server computes the value, the shell reads the
 * listing again when a DM arrives or is sent, but only for a server that has
 * shown it reports the fields. An older server keeps the single backfill
 * read it had before.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
        return ok({ threads: fx.threads });
      },
    },
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
    await settle(20);

    expect(fx.threadsCalls).toBe(before + 1);
    expect(latest("prs_ada")).toMatchObject({
      lastHumanMessageAt: "2026-10-01T13:00:00.000Z",
    });
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
});
