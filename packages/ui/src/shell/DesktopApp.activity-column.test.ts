// @vitest-environment happy-dom

/**
 * hq-message-visibility US-006: the Activity column in the desktop shell.
 *
 * The channel header carries "Activity · N" (agent and system rows the main
 * column hides). It opens the column in the thread-panel slot, which reads
 * the timeline already loaded for the conversation and grows on a wake.
 * Reply hands the row to the thread panel; closing it returns to the column.
 * Below 1000px the header shows a "People ▾" lens menu instead.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { messageTypesStore } from "../chat/message-types.svelte.js";
import { activitySession } from "../chat/activity-session.svelte.js";
import { ACTIVITY_NARROW_QUERY } from "../chat/activity-column.js";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import { takePendingChannelOpen } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

type Row = Record<string, unknown>;

const MESH_BODY =
  '{"v":1,"kind":"work-session-event","threadId":"work-desktop-dogfood:T-002","event":{"kind":"done","at":"2026-08-28T15:14:05.854Z","by":"Stefan Johnson","summary":"mesh-row-summary-xyz"}}';

const human = (n: number): Row => ({
  eventId: `evt_h_${n}`,
  fromPersonUid: "prs_ada",
  fromDisplayName: "Ada",
  body: `human-row-${n}-xyz`,
  createdAt: new Date(Date.UTC(2026, 7, 28, 10, n)).toISOString(),
  direction: "in",
});
const agentRow = (n: number): Row => ({
  eventId: `evt_a_${n}`,
  fromPersonUid: "agt_scout",
  fromDisplayName: "Scout",
  body: `agent-row-${n}-xyz`,
  createdAt: new Date(Date.UTC(2026, 7, 28, 10, n, 30)).toISOString(),
  direction: "in",
  audience: "agent",
});
const mesh = (n: number): Row => ({
  eventId: `evt_m_${n}`,
  fromPersonUid: "prs_stefan",
  fromDisplayName: "Stefan Johnson",
  body: MESH_BODY,
  createdAt: new Date(Date.UTC(2026, 7, 28, 10, n, 45)).toISOString(),
  direction: "in",
});

const CHANNEL_ROW = {
  id: "ch:chn_ops",
  kind: "channel",
  title: "ops",
  channelId: "chn_ops",
} as ConversationRow;

interface Fx {
  /** Newest-first, as the server sends it. */
  rows: Row[];
  calls: Array<Record<string, unknown>>;
}

function adapter(fx: Fx): PlatformAdapter {
  const page = (args: Record<string, unknown>) => {
    fx.calls.push(args);
    return ok({ messages: fx.rows });
  };
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    identity: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async (args: Record<string, unknown>) => page({ route: "channel", ...args }),
      fetchDmThread: async (args: Record<string, unknown>) => page({ route: "dm", ...args }),
      fetchReplyThread: async () => ok({ scope: "channel", root: null, replies: [], replyCount: 0 }),
      sendChannelMessage: async () =>
        ok({ eventId: `evt_self_${Date.now()}`, createdAt: new Date().toISOString() }),
      sendDm: async () =>
        ok({ eventId: `evt_self_${Date.now()}`, createdAt: new Date().toISOString() }),
    },
    notifications: { fetchDmInbox: async () => ok({}) },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let narrow = false;
const realMatchMedia = window.matchMedia;

function reset(): void {
  window.localStorage?.clear?.();
  takePendingConversation();
  takePendingChannelOpen();
  activitySession.reset();
}

beforeEach(() => {
  reset();
  narrow = false;
  messageTypesStore.set({ agents: false, system: false });
  window.matchMedia = ((query: string) => ({
    matches: query === ACTIVITY_NARROW_QUERY ? narrow : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.matchMedia = realMatchMedia;
  reset();
});

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountApp(fx: Fx) {
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
      initialRow: CHANNEL_ROW,
      wakes,
      coreFixtures: false,
    },
  });
  await settle(20);
  return wakes;
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const columnIds = () => qa("activity-row").map((n) => n.dataset.eventId);

describe("DesktopApp Activity column", () => {
  it("header pill counts hidden rows, opens the column in the thread slot, filters by segment, and closes", async () => {
    const fx: Fx = { rows: [human(3), agentRow(2), mesh(2), human(2), agentRow(1), human(1)], calls: [] };
    await mountApp(fx);

    const header = q("channel-header")!;
    const toggle = header.querySelector<HTMLElement>('[data-testid="activity-toggle"]')!;
    expect(toggle, "pill in the conversation header").not.toBeNull();
    expect(toggle.textContent).toContain("Activity · 3");
    expect(host.textContent).not.toContain("agent-row-1-xyz");
    for (const call of fx.calls) expect("view" in call, JSON.stringify(call)).toBe(false);

    toggle.click();
    await settle();
    const slot = q("activity-slot")!;
    expect(slot).not.toBeNull();
    expect(slot.classList.contains("reply-column")).toBe(true);
    expect(header.dataset.replyOpen).toBe("true");
    expect(columnIds()).toEqual(["evt_a_1", "evt_a_2"]);

    q("activity-segment-system")!.click();
    await settle();
    expect(columnIds()).toEqual(["evt_m_2"]);

    q("activity-close")!.click();
    await settle();
    expect(q("activity-slot")).toBeNull();
    expect(activitySession.get("ch:chn_ops").open).toBe(false);
  });

  it("grows live on a wake, and Reply opens the thread panel in its place, then returns to the column", async () => {
    const fx: Fx = { rows: [agentRow(1), human(1)], calls: [] };
    const wakes = await mountApp(fx);
    q("activity-toggle")!.click();
    await settle();
    expect(columnIds()).toEqual(["evt_a_1"]);

    fx.rows = [agentRow(5), ...fx.rows];
    wakes.emit("channel:new-message", {
      channelId: "chn_ops",
      eventId: "evt_a_5",
      createdAt: agentRow(5).createdAt as string,
      fromPersonUid: "agt_scout",
      audience: "agent",
    });
    await settle(20);
    expect(columnIds()).toEqual(["evt_a_1", "evt_a_5"]);
    expect(q("activity-toggle")!.textContent).toContain("Activity · 2");

    qa("activity-row")
      .find((n) => n.dataset.eventId === "evt_a_5")!
      .querySelector<HTMLButtonElement>('[data-testid="activity-reply"]')!
      .click();
    await settle();
    expect(q("activity-slot")).toBeNull();
    expect(q("reply-column")).not.toBeNull();

    q("reply-panel-close")!.click();
    await settle();
    expect(q("reply-column")).toBeNull();
    expect(q("activity-slot")).not.toBeNull();
  });

  it("at 900px: no third column, the People lens menu changes this conversation's main column", async () => {
    narrow = true;
    activitySession.update("ch:chn_ops", { open: true });
    const fx: Fx = { rows: [human(2), agentRow(1), human(1)], calls: [] };
    await mountApp(fx);

    expect(q("activity-toggle")).toBeNull();
    expect(q("activity-slot")).toBeNull();
    const lens = q("activity-lens")!;
    expect(lens.textContent).toContain("People ▾");
    lens.click();
    await settle();
    expect(q("activity-lens-menu")).not.toBeNull();
    q("activity-lens-all")!.click();
    await settle();

    expect(q("activity-lens")!.textContent).toContain("All ▾");
    expect(host.textContent).toContain("agent-row-1-xyz");
    expect(q("activity-slot")).toBeNull();
    // The global preference is untouched.
    expect(messageTypesStore.value).toEqual({ agents: false, system: false });
  });
});
