// @vitest-environment happy-dom

/**
 * History reads always ask for the full timeline (hq-message-visibility
 * US-006, which retired the US-004 server human view).
 *
 * With people only shown (the default), the first page and every "earlier"
 * page of a channel or a 1:1 DM is requested without `view`; agent and system
 * rows are classified and hidden on the client over the loaded page, so folds
 * and the Activity column share the one fetch. These tests drive DesktopApp
 * against a scripted adapter.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { messageTypesStore } from "../chat/message-types.svelte.js";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import {
  requestChannelOpen,
  takePendingChannelOpen,
} from "../chat/open-target.js";
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
  /**
   * Answers a request itself when it returns a page (or a promise of one,
   * which keeps the request in flight until it settles). `undefined` falls
   * through to `first` / `byCursor` / `sincePage`.
   */
  route?: (call: HistoryCall) => Page | Promise<Page> | undefined;
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

function agentRow(n: number): Record<string, unknown> {
  return {
    eventId: `evt_a_${n}`,
    fromPersonUid: "agt_scout",
    fromDisplayName: "Scout",
    body: `agent-row-${n}-xyz`,
    createdAt: new Date(Date.UTC(2026, 7, 28, 11, n)).toISOString(),
    direction: "in",
    audience: "agent",
  };
}

function adapter(fx: Fixture): PlatformAdapter {
  const serve = (call: HistoryCall): Page | Promise<Page> => {
    fx.calls.push(call);
    const routed = fx.route?.(call);
    if (routed !== undefined) return routed;
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
        ok(await serve({ route: "channel", ...args })),
      fetchDmThread: async (args: Omit<HistoryCall, "route">) =>
        ok(await serve({ route: "dm", ...args })),
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

/**
 * The retired `desktop.human-only-conversations` flag is now the message-types
 * preference (hq-message-visibility US-004). `humanOnly: false` maps to both
 * switches on and `true` to the default (people only); `undefined` leaves
 * the store as the test set it. Reset to the default before each test.
 */
function applyMessageTypes(humanOnly: boolean | undefined): void {
  // Undefined: the test set the store itself (or left the default).
  if (humanOnly === undefined) return;
  messageTypesStore.set(
    humanOnly === false ? { agents: true, system: true } : { agents: false, system: false },
  );
}
beforeEach(() => {
  messageTypesStore.set({ agents: false, system: false });
});

async function mountApp(
  fx: Fixture,
  row: ConversationRow,
): Promise<ReturnType<typeof createChatWakeBus>> {
  applyMessageTypes(fx.humanOnly);
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

describe("DesktopApp history: people only reads the full timeline", () => {
  it("a full page: the first request carries no view, rows render, and earlier pages go back with the cursor and no view", async () => {
    const fx = fixture({
      first: { messages: [human(3), mesh(1), human(2)], nextCursor: "cur_1" },
      byCursor: { cur_1: { messages: [human(1)] } },
    });
    await mountApp(fx, CHANNEL_ROW);

    // The history load is the first request, and it asks for the full timeline.
    expect(fx.calls[0]).toMatchObject({
      route: "channel",
      channelId: "chn_ops",
      limit: 50,
    });
    expect("view" in fx.calls[0], JSON.stringify(fx.calls[0])).toBe(false);
    expect(fx.calls[0].cursor ?? null).toBeNull();
    expect(fx.calls[0].since ?? null).toBeNull();
    expect(earlierCalls(fx)).toHaveLength(0);
    expect(host.textContent).toContain("human-row-3-xyz");
    expect(host.textContent).toContain("human-row-2-xyz");
    // The agent / system row loaded with the page is hidden on the client.
    expect(host.textContent).not.toContain("mesh-row-summary-xyz");

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
    });
    expect("view" in earlierCalls(fx)[0]).toBe(false);
    expect(host.textContent).toContain("human-row-1-xyz");
    // The last page had no cursor: no more history, no button.
    expect(loadEarlierButton()).toBeNull();
  });

  it("pages of only hidden rows, then a page with human rows: the pane keeps fetching (no view) and never shows an empty pane with a button", async () => {
    const fx = fixture({
      first: { messages: [mesh(3)], nextCursor: "cur_1" },
      byCursor: {
        cur_1: { messages: [mesh(2)], nextCursor: "cur_2" },
        cur_2: { messages: [human(2), human(1)] },
      },
    });
    await mountApp(fx, CHANNEL_ROW);
    await settle(30);

    expect(earlierCalls(fx).map((call) => call.cursor)).toEqual(["cur_1", "cur_2"]);
    for (const call of fx.calls) {
      expect("view" in call, JSON.stringify(call)).toBe(false);
    }
    expect(host.textContent).toContain("human-row-1-xyz");
    expect(host.textContent).toContain("human-row-2-xyz");
    expect(q("conversation-empty")).toBeNull();
    expect(q("conversation-scan-paused")).toBeNull();
    expect(loadEarlierButton()).toBeNull();
  });

  it("an empty page with no cursor: the empty state and no button", async () => {
    const fx = fixture({ first: { messages: [] } });
    await mountApp(fx, CHANNEL_ROW);
    await settle(20);

    expect(earlierCalls(fx)).toHaveLength(0);
    expect(q("conversation-empty")).not.toBeNull();
    expect(loadEarlierButton()).toBeNull();
    expect(q("conversation-scan-paused")).toBeNull();
  });

  it("1:1 DM: the thread route gets no view, and agent and system rows on the page are hidden locally", async () => {
    const fx = fixture({
      first: { messages: [human(3), mesh(2), agentRow(1), human(2)] },
    });
    await mountApp(fx, DM_ROW);

    expect(fx.calls[0]).toMatchObject({
      route: "dm",
      withPersonUid: "prs_ada",
      limit: 50,
    });
    expect("view" in fx.calls[0], JSON.stringify(fx.calls[0])).toBe(false);
    expect(fx.calls[0].cursor ?? null).toBeNull();
    expect(host.textContent).toContain("human-row-3-xyz");
    expect(host.textContent).toContain("human-row-2-xyz");
    expect(host.textContent).not.toContain("mesh-row-summary-xyz");
    expect(host.textContent).not.toContain("agent-row-1-xyz");
  });

  it("1:1 DM with 4 human messages and 30 agent updates: one full-timeline read, 4 rows on screen", async () => {
    const rows = [];
    for (let i = 30; i >= 1; i -= 1) rows.push(agentRow(i));
    rows.splice(0, 0, human(4));
    rows.splice(10, 0, human(3));
    rows.splice(20, 0, human(2));
    rows.push(human(1));
    const fx = fixture({ first: { messages: rows } });
    await mountApp(fx, DM_ROW);
    await settle(20);

    const history = fx.calls.filter((call) => call.route === "dm" && !call.since && !call.cursor);
    expect(history.length).toBeGreaterThanOrEqual(1);
    for (const call of fx.calls) {
      expect("view" in call, JSON.stringify(call)).toBe(false);
    }
    for (const n of [1, 2, 3, 4]) expect(host.textContent).toContain(`human-row-${n}-xyz`);
    expect(host.textContent).not.toContain("agent-row-");
  });

  it("a live catch-up read stays unfiltered: a new-message wake sends since and no view", async () => {
    const fx = fixture({
      first: { messages: [human(1)] },
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
    const fx = fixture({ first: { messages: [] } });
    const wakes = await mountApp(fx, CHANNEL_ROW);
    await settle(20);
    const before = fx.calls.length;
    expect(before).toBeGreaterThanOrEqual(1);
    for (const call of fx.calls.slice(0, before)) {
      expect("view" in call, JSON.stringify(call)).toBe(false);
    }

    wakes.emit("mesh:catchup", { reason: "focus" });
    await settle(20);

    const after = fx.calls.slice(before).filter((call) => call.route === "channel");
    expect(after.length).toBeGreaterThanOrEqual(1);
    for (const call of after) {
      expect("view" in call, JSON.stringify(call)).toBe(false);
    }
  });

  it("the person's own just-sent message stays on screen, and the rail is told about the send", async () => {
    const fx = fixture({ first: { messages: [human(1)] } });
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

describe("DesktopApp human view history: a run of earlier requests ends with its conversation", () => {
  it("switching conversations during a run: the old run asks for nothing more, and the new conversation gets only its own run", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // One hidden row per page, fixed by the page's cursor so a re-read of a
    // page returns the same row.
    const emptyPage = (next: string): Page => {
      const [prefix, n] = next.split("_");
      return {
        messages: [mesh((prefix === "ops" ? 100 : 200) + Number(n))],
        nextCursor: next,
      };
    };
    // Both channels hold nothing a person typed, and the server always has
    // a further cursor: every page holds only hidden rows.
    const fx = fixture({
      route: (call) => {
        if (call.since) return undefined;
        const prefix = call.channelId === "chn_ops" ? "ops" : "design";
        if (!call.cursor) return emptyPage(`${prefix}_1`);
        const n = Number(call.cursor.split("_")[1]);
        const page = emptyPage(`${prefix}_${n + 1}`);
        // The first conversation's second earlier request stays in flight
        // until the test releases it.
        if (call.cursor === "ops_2") return held.then(() => page);
        return page;
      },
    });
    const cursorsFor = (channelId: string) =>
      earlierCalls(fx)
        .filter((call) => call.channelId === channelId)
        .map((call) => call.cursor);
    // The bounded auto-fetch: five earlier pages per open conversation.
    const ownRun = [1, 2, 3, 4, 5].map((n) => `design_${n}`);

    await mountApp(fx, CHANNEL_ROW);
    // The open-time run for the first conversation is under way and waiting
    // on its second request.
    expect(cursorsFor("chn_ops")).toEqual(["ops_1", "ops_2"]);
    expect(cursorsFor("chn_design")).toEqual([]);

    requestChannelOpen("chn_design", { title: "design" });
    await settle(40);

    // The new conversation's own open-time run: five requests, each for the
    // next cursor, then the ordinary pager.
    expect(cursorsFor("chn_design")).toEqual(ownRun);

    // The first conversation's request now answers. Its run started for a
    // conversation that is no longer open, so it must not ask again: the
    // shell would apply the request to the conversation that is open now.
    release();
    await settle(40);

    expect(cursorsFor("chn_ops")).toEqual(["ops_1", "ops_2"]);
    expect(cursorsFor("chn_design")).toEqual(ownRun);
    expect(
      fx.calls.filter((call) => call.route === "dm"),
      "no DM thread request",
    ).toHaveLength(0);
    for (const call of fx.calls) {
      expect("view" in call, JSON.stringify(call)).toBe(false);
    }
    expect(loadEarlierButton()?.textContent).toContain("Load earlier messages");
  });
});

describe("DesktopApp history: unfiltered pages, filtered locally", () => {
  it("channel: the request carries no view, the unfiltered page is filtered locally, and paging works as before", async () => {
    const fx = fixture({
      // No `view` in the responses: the server ignored the parameter.
      first: { messages: [mesh(2), human(2), mesh(1)], nextCursor: "old_cur_1" },
      byCursor: { old_cur_1: { messages: [human(1)] } },
    });
    await mountApp(fx, CHANNEL_ROW);

    expect(fx.calls[0]).toMatchObject({ route: "channel", limit: 50 });
    expect("view" in fx.calls[0], JSON.stringify(fx.calls[0])).toBe(false);
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

  it("1:1 DM: the thread keeps its newest window, with no cursor and no earlier paging", async () => {
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
  it("Agents & CLI and System events on: no request carries view, for a channel or a DM, first page or earlier", async () => {
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

  it("message types on, DM: the thread request carries no view", async () => {
    const fx = fixture({ humanOnly: false, first: { messages: [human(1)] } });
    await mountApp(fx, DM_ROW);
    expect(fx.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of fx.calls) {
      expect(call.route).toBe("dm");
      expect("view" in call, JSON.stringify(call)).toBe(false);
    }
  });

  it("a host that cannot answer feature flags still follows the stored preference: Agents & CLI on sends no view", async () => {
    const fx = fixture({ humanOnly: undefined, first: { messages: [human(1)] } });
    messageTypesStore.set({ agents: true, system: false });
    await mountApp(fx, CHANNEL_ROW);
    expect(fx.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of fx.calls) {
      expect("view" in call, JSON.stringify(call)).toBe(false);
    }
    expect(host.textContent).toContain("human-row-1-xyz");
  });
});
