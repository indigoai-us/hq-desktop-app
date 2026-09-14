// @vitest-environment happy-dom

/**
 * "Izzy is thinking…" must survive navigation. The shell used to keep one
 * flat thinking list and wipe it on every row switch, so peeking at another
 * conversation and coming back dropped the indicator while the agent was
 * still working. Rows are now keyed per conversation and clear only on the
 * signal that ends them — a NEWER message from that agent in that row
 * (including background wakes while the row is not open), a failed send in
 * that row, or the hard expiry. Never a row switch.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus, type ChatSidebarApi } from "../chat/chat-api.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import { takePendingChannelOpen } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { MentionTarget } from "../chat/mentions.js";

/** Mutable timelines the fake adapter serves for every conversation. */
interface Fixture {
  messages: Array<Record<string, unknown>>;
  failSend: boolean;
}

function adapter(fx: Fixture): PlatformAdapter {
  const failed = () =>
    ({ ok: false as const, reason: "unavailable", message: "nope" });
  const sent = () =>
    ok({ eventId: `evt_self_${Date.now()}`, createdAt: new Date().toISOString() });
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [...fx.messages].reverse() }),
      fetchDmThread: async () => ok({ messages: [...fx.messages].reverse() }),
      sendChannelMessage: async () => (fx.failSend ? failed() : sent()),
      sendDm: async () => (fx.failSend ? failed() : sent()),
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

const NOW = new Date().toISOString();

/** Rail with two linked (`chn_`) channels and a DM with the agent, so every
 *  row the tests navigate between has a real button in the sidebar. */
function sidebarApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      contractVersion: 2,
      snapshot: true,
      cursor: "cursor00000000000000000000000000000000000",
      cursorExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      rows: [
        {
          channelId: "chn_a",
          type: "project",
          scope: "project",
          companyUid: null,
          name: "alpha",
          subtitle: "project",
          lastActivityAt: NOW,
          unreadCount: 0,
          memberCount: 2,
        },
        {
          channelId: "chn_b",
          type: "project",
          scope: "project",
          companyUid: null,
          name: "beta",
          subtitle: "project",
          lastActivityAt: NOW,
          unreadCount: 0,
          memberCount: 2,
        },
      ],
    }),
    listContacts: async () => ({
      contacts: [
        {
          personUid: "agt_izzy",
          email: null,
          displayName: "Izzy",
          lastMessageAt: NOW,
          lastActivityAt: NOW,
        },
      ],
    }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => ({ channels: [] }),
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
  } as unknown as ChatSidebarApi;
}

const ROW_A: ConversationRow = {
  id: "ch:chn_a",
  kind: "channel",
  title: "alpha",
  channelId: "chn_a",
} as ConversationRow;
const ROW_B_ID = "ch:chn_b";
const DM_ROW: ConversationRow = {
  id: "dm:agt_izzy",
  kind: "dm",
  title: "Izzy",
  personUid: "agt_izzy",
} as ConversationRow;

const IZZY: MentionTarget = {
  participantUid: "agt_izzy",
  participantType: "agent",
  displayName: "Izzy",
};

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

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountApp(
  fx: Fixture,
  initialRow: ConversationRow = ROW_A,
): Promise<ReturnType<typeof createChatWakeBus>> {
  const wakes = createChatWakeBus();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(fx),
      sidebarApi: sidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      initialRow,
      mentionCandidates: [IZZY],
      wakes,
      coreFixtures: false,
    },
  });
  await settle();
  return wakes;
}

async function openRow(rowId: string): Promise<void> {
  let btn: HTMLButtonElement | null = null;
  for (let i = 0; i < 20 && !btn; i += 1) {
    btn = host.querySelector<HTMLButtonElement>(
      `[data-conversation-id="${rowId}"]`,
    );
    if (!btn) await settle(2);
  }
  expect(btn, `rail row ${rowId}`).toBeTruthy();
  btn!.click();
  await settle(10);
}

function composer(): HTMLTextAreaElement {
  const el = host.querySelector<HTMLTextAreaElement>(
    '[data-testid="conversation-composer"]',
  );
  expect(el, "live composer is mounted").toBeTruthy();
  return el!;
}

function thinkingRow(): Element | null {
  return host.querySelector('[data-testid="agent-thinking-row"]');
}

/** Drive the real composer: @mention Izzy via the picker, then Enter-send. */
async function sendMentionMessage(): Promise<void> {
  const el = composer();
  el.value = "@Izzy";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  const pick = host.querySelector<HTMLButtonElement>(
    '[data-testid="mention-picker"] button',
  );
  expect(pick, "mention picker offers the agent").toBeTruthy();
  pick!.click();
  await settle();
  el.value = `${el.value} take a look`;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(10);
}

/** Plain text send — an agent DM needs no @mention to start the row. */
async function sendPlainMessage(): Promise<void> {
  const el = composer();
  el.value = "hey";
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(10);
}

function expectOpen(name: string): void {
  expect(host.querySelector('[data-testid="channel-name"]')?.textContent).toBe(name);
}

describe("DesktopApp agent thinking persists across navigation", () => {
  it("keeps the channel row after navigating away and back", async () => {
    const fx: Fixture = { messages: [], failSend: false };
    await mountApp(fx);
    await sendMentionMessage();
    expect(thinkingRow()?.textContent).toContain("Izzy is thinking");

    await openRow(ROW_B_ID);
    expectOpen("beta");
    expect(thinkingRow(), "B has no status of its own").toBeNull();

    await openRow(ROW_A.id);
    expectOpen("alpha");
    expect(thinkingRow()?.textContent, "A's status survived the round trip").toContain(
      "Izzy is thinking",
    );
  });

  it("clears the channel row when the agent replies while another conversation is open", async () => {
    const fx: Fixture = { messages: [], failSend: false };
    const wakes = await mountApp(fx);
    await sendMentionMessage();
    expect(thinkingRow()).toBeTruthy();

    await openRow(ROW_B_ID);
    expectOpen("beta");
    // The reply is only announced by the wake; the served timeline never
    // carries it, so the wake itself must have ended the row.
    wakes.emit("channel:new-message", {
      channelId: "chn_a",
      eventId: "evt_izzy_1",
      createdAt: new Date().toISOString(),
      fromPersonUid: "agt_izzy",
    });
    await settle(10);

    await openRow(ROW_A.id);
    expectOpen("alpha");
    expect(thinkingRow(), "reply while away ended the row").toBeNull();
  });

  it("clears the DM row when the agent's DM lands while another conversation is open", async () => {
    const fx: Fixture = { messages: [], failSend: false };
    const wakes = await mountApp(fx, DM_ROW);
    await sendPlainMessage();
    expect(thinkingRow()?.textContent).toContain("Izzy is thinking");

    await openRow(ROW_B_ID);
    expectOpen("beta");
    // Outbound echo for the same pair must not clear it …
    wakes.emit("dm:new-message", {
      fromPersonUid: "agt_izzy",
      eventId: "evt_me_1",
      createdAt: new Date().toISOString(),
      direction: "out",
    });
    await settle(10);
    await openRow(DM_ROW.id);
    expect(thinkingRow(), "outbound echo keeps the row").toBeTruthy();

    // … but the agent's inbound reply does, even while B is open.
    await openRow(ROW_B_ID);
    wakes.emit("dm:new-message", {
      fromPersonUid: "agt_izzy",
      eventId: "evt_izzy_1",
      createdAt: new Date().toISOString(),
      direction: "in",
    });
    await settle(10);
    await openRow(DM_ROW.id);
    expect(thinkingRow(), "inbound agent DM ended the row").toBeNull();
  });

  it("a failed send clears only that conversation's rows", async () => {
    const fx: Fixture = { messages: [], failSend: false };
    await mountApp(fx);
    await sendMentionMessage();
    expect(thinkingRow()).toBeTruthy();

    await openRow(ROW_B_ID);
    expectOpen("beta");
    fx.failSend = true;
    await sendMentionMessage();
    expect(thinkingRow(), "failed send in B never shows a row there").toBeNull();

    await openRow(ROW_A.id);
    expectOpen("alpha");
    expect(thinkingRow()?.textContent, "A's row is untouched by B's failure").toContain(
      "Izzy is thinking",
    );
  });
});
