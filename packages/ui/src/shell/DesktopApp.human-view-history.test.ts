// @vitest-environment happy-dom

/**
 * Human-only history requests ask the server for the human view.
 *
 * In humanOnly mode the first page and every "earlier" page of a channel or
 * a 1:1 DM is requested with `view: "human"`. A server that implements it
 * echoes `view: "human"` and pages on its side; an older server ignores the
 * parameter and returns an ordinary unfiltered page with no echo. These
 * tests drive DesktopApp against a scripted adapter playing each server.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import { takePendingChannelOpen } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

interface HistoryCall {
  route: "channel" | "dm";
  channelId?: string;
  withPersonUid?: string;
  limit?: number;
  cursor?: string | null;
  since?: string | null;
  view?: string;
}

type Page = Record<string, unknown>;

interface Fixture {
  /** Flag answer; `undefined` leaves the adapter without `hasFeature`. */
  humanOnly: boolean | undefined;
  /** The newest page: served to every request with no cursor and no `since`. */
  first: Page;
  /** Earlier pages by the cursor that requests them. */
  byCursor: Record<string, Page> | ((cursor: string) => Page);
  /** Served to `since` catch-up reads. */
  sincePage: Page;
  calls: HistoryCall[];
}

const MESH_BODY =
  '{"v":1,"kind":"work-session-event","threadId":"work-desktop-dogfood:T-002","event":{"kind":"done","at":"2026-08-28T15:14:05.854Z","by":"Stefan Johnson","summary":"mesh-row-summary-xyz"}}';

function human(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: `evt_h_${n}`,
    fromPersonUid: "prs_ada",
    fromDisplayName: "Ada",
    body: `human-row-${n}-xyz`,
    createdAt: new Date(Date.UTC(2026, 7, 28, 10, n)).toISOString(),
    direction: "in",
    ...extra,
  };
}

function mesh(n: number): Record<string, unknown> {
  return {
    eventId: `evt_m_${n}`,
    fromPersonUid: "prs_stefan",
    fromDisplayName: "Stefan Johnson",
    body: MESH_BODY,
    createdAt: new Date(Date.UTC(2026, 7, 28, 12, n)).toISOString(),
    direction: "in",
  };
}

function adapter(fx: Fixture): PlatformAdapter {
  const serve = (call: HistoryCall): Page => {
    fx.calls.push(call);
    if (call.since) return fx.sincePage;
    if (!call.cursor) return fx.first;
    return typeof fx.byCursor === "function"
      ? fx.byCursor(call.cursor)
      : (fx.byCursor[call.cursor] ?? { messages: [] });
  };
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    identity:
      fx.humanOnly === undefined
        ? {}
        : {
            hasFeature: async () => ok(fx.humanOnly === true),
            subscribeFeature: () => () => {},
          },
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async (args: Omit<HistoryCall, "route">) =>
        ok(serve({ route: "channel", ...args })),
      fetchDmThread: async (args: Omit<HistoryCall, "route">) =>
        ok(serve({ route: "dm", ...args })),
      sendChannelMessage: async () =>
        ok({ eventId: `evt_self_${Date.now()}`, createdAt: new Date().toISOString() }),
      sendDm: async () =>
        ok({ eventId: `evt_self_${Date.now()}`, createdAt: new Date().toISOString() }),
    },
    notifications: {
      fetchDmInbox: async () => ok({}),
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

const CHANNEL_ROW = {
  id: "ch:chn_ops",
  kind: "channel",
  title: "ops",
  channelId: "chn_ops",
} as ConversationRow;

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

function fixture(partial: Partial<Fixture> = {}): Fixture {
  return {
    humanOnly: true,
    first: { messages: [] },
    byCursor: {},
    sincePage: { messages: [] },
    calls: [],
    ...partial,
  };
}

async function mountApp(
  fx: Fixture,
  row: ConversationRow,
): Promise<ReturnType<typeof createChatWakeBus>> {
  const wakes = createChatWakeBus();
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
      initialRow: row,
      wakes,
      coreFixtures: false,
    },
  });
  await settle(20);
  return wakes;
}

const q = (testid: string) => host.querySelector(`[data-testid="${testid}"]`);
const loadEarlierButton = () =>
  q("conversation-load-earlier") as HTMLButtonElement | null;
/** Live re-reads raised by a wake: the small page size, never a cursor. */
const liveCalls = (fx: Fixture) =>
  fx.calls.filter((call) => !call.cursor && call.limit === 20);
/** Requests for an earlier page, in order. */
const earlierCalls = (fx: Fixture) => fx.calls.filter((call) => call.cursor);

describe("DesktopApp human view history: server that echoes view: \"human\"", () => {
  it("a full page: the first request carries view=human, rows render, and earlier pages go back with the cursor and the view", async () => {
    const fx = fixture({
      first: { messages: [human(3), human(2)], view: "human", nextCursor: "cur_1" },
      byCursor: { cur_1: { messages: [human(1)], view: "human" } },
    });
    await mountApp(fx, CHANNEL_ROW);

    // The history load is the first request, and it asks for the human view.
    expect(fx.calls[0]).toMatchObject({
      route: "channel",
      channelId: "chn_ops",
      limit: 50,
      view: "human",
    });
    expect(fx.calls[0].cursor ?? null).toBeNull();
    expect(fx.calls[0].since ?? null).toBeNull();
    expect(earlierCalls(fx)).toHaveLength(0);
    expect(host.textContent).toContain("human-row-3-xyz");
    expect(host.textContent).toContain("human-row-2-xyz");

    // hasEarlier is exactly "the page carried a cursor".
    const button = loadEarlierButton();
    expect(button, "a cursor means earlier history").not.toBeNull();
    button!.click();
    await settle(20);

    expect(earlierCalls(fx)).toHaveLength(1);
    expect(earlierCalls(fx)[0]).toMatchObject({
      route: "channel",
      channelId: "chn_ops",
      cursor: "cur_1",
      view: "human",
    });
    expect(host.textContent).toContain("human-row-1-xyz");
    // The last page had no cursor: no more history, no button.
    expect(loadEarlierButton()).toBeNull();
  });

  it("a truncated empty page, then a page with human rows: the pane keeps fetching and never shows an empty pane with a button", async () => {
    const fx = fixture({
      first: { messages: [], view: "human", nextCursor: "cur_1", viewScanTruncated: true },
      byCursor: {
        cur_1: { messages: [], view: "human", nextCursor: "cur_2", viewScanTruncated: true },
        cur_2: { messages: [human(2), human(1)], view: "human" },
      },
    });
    await mountApp(fx, CHANNEL_ROW);
    await settle(30);

    expect(earlierCalls(fx).map((call) => call.cursor)).toEqual(["cur_1", "cur_2"]);
    expect(fx.calls[0].view).toBe("human");
    expect(earlierCalls(fx).every((call) => call.view === "human")).toBe(true);
    expect(host.textContent).toContain("human-row-1-xyz");
    expect(host.textContent).toContain("human-row-2-xyz");
    expect(q("conversation-empty")).toBeNull();
    expect(q("conversation-scan-paused")).toBeNull();
    expect(loadEarlierButton()).toBeNull();
  });

  it("an empty page with no cursor: the empty state and no button", async () => {
    const fx = fixture({ first: { messages: [], view: "human" } });
    await mountApp(fx, CHANNEL_ROW);
    await settle(20);

    expect(earlierCalls(fx)).toHaveLength(0);
    expect(q("conversation-empty")).not.toBeNull();
    expect(loadEarlierButton()).toBeNull();
    expect(q("conversation-scan-paused")).toBeNull();
  });

  it("1:1 DM: the thread route gets view=human, and its cursor pages earlier history", async () => {
    const fx = fixture({
      first: { messages: [human(3), human(2)], view: "human", nextCursor: "dm_cur_1" },
      byCursor: { dm_cur_1: { messages: [human(1)], view: "human" } },
    });
    await mountApp(fx, DM_ROW);

    expect(fx.calls[0]).toMatchObject({
      route: "dm",
      withPersonUid: "prs_ada",
      limit: 50,
      view: "human",
    });
    expect(fx.calls[0].cursor ?? null).toBeNull();
    expect(host.textContent).toContain("human-row-3-xyz");

    const button = loadEarlierButton();
    expect(button, "the echoed DM page carried a cursor").not.toBeNull();
    button!.click();
    await settle(20);

    expect(earlierCalls(fx)).toHaveLength(1);
    expect(earlierCalls(fx)[0]).toMatchObject({
      route: "dm",
      withPersonUid: "prs_ada",
      cursor: "dm_cur_1",
      view: "human",
    });
    expect(host.textContent).toContain("human-row-1-xyz");
    expect(loadEarlierButton()).toBeNull();
  });

  it("1:1 DM: a truncated empty thread page keeps fetching until rows arrive", async () => {
    const fx = fixture({
      first: { messages: [], view: "human", nextCursor: "dm_cur_1", viewScanTruncated: true },
      byCursor: { dm_cur_1: { messages: [human(1)], view: "human" } },
    });
    await mountApp(fx, DM_ROW);
    await settle(30);

    expect(earlierCalls(fx).map((call) => [call.route, call.cursor, call.view])).toEqual([
      ["dm", "dm_cur_1", "human"],
    ]);
    expect(host.textContent).toContain("human-row-1-xyz");
  });

  it("a live catch-up read stays unfiltered: a new-message wake sends since and no view", async () => {
    const fx = fixture({
      first: { messages: [human(1)], view: "human" },
      sincePage: {
        messages: [human(9, { createdAt: "2026-09-01T10:00:00.000Z" })],
      },
    });
    const wakes = await mountApp(fx, CHANNEL_ROW);
    wakes.emit("channel:new-message", {
      channelId: "chn_ops",
      eventId: "evt_h_9",
      createdAt: "2026-09-01T10:00:00.000Z",
      fromPersonUid: "prs_ada",
    });
    await settle(20);

    expect(liveCalls(fx).length).toBeGreaterThanOrEqual(1);
    expect(liveCalls(fx).some((call) => Boolean(call.since))).toBe(true);
    for (const call of liveCalls(fx)) {
      expect("view" in call, JSON.stringify(call)).toBe(false);
    }
    // The newly arrived human message is on screen.
    expect(host.textContent).toContain("human-row-9-xyz");
  });

  it("a catch-up read sends no view even when nothing is on screen to take a since from", async () => {
    const fx = fixture({ first: { messages: [], view: "human" } });
    const wakes = await mountApp(fx, CHANNEL_ROW);
    await settle(20);
    const before = fx.calls.length;
    expect(fx.calls.slice(0, before).some((call) => call.view === "human")).toBe(true);

    wakes.emit("mesh:catchup", { reason: "focus" });
    await settle(20);

    const after = fx.calls.slice(before).filter((call) => call.route === "channel");
    expect(after.length).toBeGreaterThanOrEqual(1);
    for (const call of after) {
      expect("view" in call, JSON.stringify(call)).toBe(false);
    }
  });

  it("the person's own just-sent message stays on screen, and the rail is told about the send", async () => {
    const fx = fixture({ first: { messages: [human(1)], view: "human" } });
    const wakes = await mountApp(fx, CHANNEL_ROW);
    const ownSends: string[] = [];
    wakes.on("channel:own-send", ({ channelId }) => {
      ownSends.push(channelId);
    });
    const composer = q("conversation-composer") as HTMLTextAreaElement | null;
    expect(composer, "live composer is mounted").not.toBeNull();
    composer!.value = "my-own-send-xyz";
    composer!.dispatchEvent(new Event("input", { bubbles: true }));
    composer!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await settle(20);
    expect(host.textContent).toContain("my-own-send-xyz");
    expect(host.textContent).toContain("human-row-1-xyz");
    // The rail is told a person typed in this channel.
    expect(ownSends).toEqual(["chn_ops"]);
  });
});

describe("DesktopApp human view history: older server (no view echo)", () => {
  it("channel: the request carries view=human, the unfiltered page is filtered locally, and paging works as before", async () => {
    const fx = fixture({
      // No `view` in the responses: the server ignored the parameter.
      first: { messages: [mesh(2), human(2), mesh(1)], nextCursor: "old_cur_1" },
      byCursor: { old_cur_1: { messages: [human(1)] } },
    });
    await mountApp(fx, CHANNEL_ROW);

    expect(fx.calls[0]).toMatchObject({ route: "channel", limit: 50, view: "human" });
    expect(earlierCalls(fx)).toHaveLength(0);
    // Local filter: the mesh rows the old server sent are hidden.
    expect(host.textContent).toContain("human-row-2-xyz");
    expect(host.textContent).not.toContain("mesh-row-summary-xyz");
    expect(host.querySelector(".work-mesh-row")).toBeNull();
    expect(q("conversation-scan-paused")).toBeNull();

    loadEarlierButton()!.click();
    await settle(20);
    expect(earlierCalls(fx)).toHaveLength(1);
    expect(earlierCalls(fx)[0]).toMatchObject({ cursor: "old_cur_1" });
    expect(host.textContent).toContain("human-row-1-xyz");
  });

  it("channel: a page of only hidden rows auto-fetches older pages, bounded to five", async () => {
    // Every page is mesh-only and keeps a cursor.
    const fx = fixture({
      first: { messages: [mesh(0)], nextCursor: "old_cur_1" },
      byCursor: (cursor) => {
        const n = Number(cursor.replace("old_cur_", ""));
        return { messages: [mesh(n)], nextCursor: `old_cur_${n + 1}` };
      },
    });
    await mountApp(fx, CHANNEL_ROW);
    await settle(60);

    // The bounded auto-fetch from before this option existed: five pages.
    expect(earlierCalls(fx).map((call) => call.cursor)).toEqual([
      "old_cur_1",
      "old_cur_2",
      "old_cur_3",
      "old_cur_4",
      "old_cur_5",
    ]);
    expect(q("conversation-scan-paused")).toBeNull();
    expect(loadEarlierButton()?.textContent ?? "").toContain("Load earlier messages");
  });

  it("1:1 DM: without the echo the thread gets no cursor and no earlier paging, as before", async () => {
    const fx = fixture({
      first: { messages: [human(2), human(1)], nextCursor: "old_dm_cur" },
    });
    await mountApp(fx, DM_ROW);
    await settle(20);

    expect(earlierCalls(fx)).toHaveLength(0);
    expect(host.textContent).toContain("human-row-2-xyz");
    expect(loadEarlierButton()).toBeNull();
  });
});

describe("DesktopApp human view history: when view is not sent", () => {
  it("flag off: no request carries view, for a channel or a DM, first page or earlier", async () => {
    const fx = fixture({
      humanOnly: false,
      first: { messages: [mesh(1), human(2)], nextCursor: "cur_1" },
      byCursor: { cur_1: { messages: [human(1)] } },
    });
    await mountApp(fx, CHANNEL_ROW);
    expect(host.textContent).toContain("human-row-2-xyz");
    loadEarlierButton()!.click();
    await settle(20);

    expect(earlierCalls(fx)).toHaveLength(1);
    expect(fx.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of fx.calls) {
      expect("view" in call, JSON.stringify(call)).toBe(false);
    }
  });

  it("flag off, DM: the thread request carries no view", async () => {
    const fx = fixture({ humanOnly: false, first: { messages: [human(1)] } });
    await mountApp(fx, DM_ROW);
    expect(fx.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of fx.calls) {
      expect(call.route).toBe("dm");
      expect("view" in call, JSON.stringify(call)).toBe(false);
    }
  });

  it("a host that cannot answer the flag sends no view (the default is not a confirmation)", async () => {
    const fx = fixture({ humanOnly: undefined, first: { messages: [human(1)] } });
    await mountApp(fx, CHANNEL_ROW);
    expect(fx.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of fx.calls) {
      expect("view" in call, JSON.stringify(call)).toBe(false);
    }
    expect(host.textContent).toContain("human-row-1-xyz");
  });
});
