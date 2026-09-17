// @vitest-environment happy-dom

/**
 * A bot's DM reply must appear the moment its wake arrives.
 *
 * The owner sent "do something long" to a local bot, saw the thinking row,
 * got the notification for the reply — and then BOTH the thinking row and the
 * reply were gone. The `dm:new-message` handler cleared the agent's thinking
 * row from the bare wake and only refreshed the rail; nothing re-read the OPEN
 * DM timeline, and on a healthy mesh the safety ticker that would have caught
 * it up is not armed. These tests pin the fixed ordering: the open DM fetches
 * its page, the reply lands, and only then does the indicator go away.
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

interface DmCall {
  withPersonUid?: string;
  since?: string;
  limit?: number;
}

interface Gate {
  promise: Promise<void>;
  release: () => void;
}

function gate(): Gate {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

/** Mutable DM page the fake adapter serves, plus a call log and a gate so a
 *  test can hold the fetch open and inspect the screen mid-flight. */
interface Fixture {
  dm: Array<Record<string, unknown>>;
  calls: DmCall[];
  pending: Gate | null;
  failDm: boolean;
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
      fetchDmThread: async (args: DmCall) => {
        fx.calls.push(args);
        if (fx.pending) await fx.pending.promise;
        if (fx.failDm) {
          return { ok: false as const, reason: "unavailable", message: "nope" };
        }
        return ok({ messages: [...fx.dm].reverse() });
      },
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

const NOW = new Date().toISOString();
const AGENT = "agt_izzy";
const REPLY_AT = new Date(Date.now() + 60_000).toISOString();

/** Rail with one channel to navigate to and a DM with the agent. */
function sidebarApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      contractVersion: 2,
      snapshot: true,
      cursor: "cursor00000000000000000000000000000000000",
      cursorExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      rows: [
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
          personUid: AGENT,
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

const DM_ROW: ConversationRow = {
  id: `dm:${AGENT}`,
  kind: "dm",
  title: "Izzy",
  personUid: AGENT,
} as ConversationRow;
const ROW_B_ID = "ch:chn_b";

const IZZY: MentionTarget = {
  participantUid: AGENT,
  participantType: "agent",
  displayName: "Izzy",
};

const REPLY = {
  eventId: "evt_izzy_1",
  fromPersonUid: AGENT,
  fromDisplayName: "Izzy",
  body: "Here is the long thing you asked for",
  createdAt: REPLY_AT,
  direction: "in",
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

function fixture(): Fixture {
  return { dm: [], calls: [], pending: null, failDm: false };
}

async function mountApp(
  fx: Fixture,
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
      initialRow: DM_ROW,
      mentionCandidates: [IZZY],
      wakes,
      coreFixtures: false,
    },
  });
  await settle(10);
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

function thinkingRow(): Element | null {
  return host.querySelector('[data-testid="agent-thinking-row"]');
}

function replyRow(): Element | null {
  return host.querySelector(
    '[data-testid="conversation-message"][data-event-id="evt_izzy_1"]',
  );
}

/** Plain text send — an agent DM needs no @mention to start the row. */
async function sendPlainMessage(): Promise<void> {
  const el = host.querySelector<HTMLTextAreaElement>(
    '[data-testid="conversation-composer"]',
  );
  expect(el, "live composer is mounted").toBeTruthy();
  el!.value = "do something long";
  el!.dispatchEvent(new Event("input", { bubbles: true }));
  el!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(10);
}

describe("DesktopApp shows a DM reply when its wake arrives", () => {
  it("fetches the open DM page and clears the thinking row only once the reply is on screen", async () => {
    const fx = fixture();
    const wakes = await mountApp(fx);
    await sendPlainMessage();
    expect(thinkingRow()?.textContent, "the bot's row is up").toContain("Izzy");

    const before = fx.calls.length;
    const held = gate();
    fx.pending = held;
    fx.dm = [REPLY];

    wakes.emit("dm:new-message", {
      fromPersonUid: AGENT,
      eventId: REPLY.eventId,
      createdAt: REPLY_AT,
      direction: "in",
    });
    await settle(10);

    expect(fx.calls.length, "the wake refreshed the open DM").toBe(before + 1);
    expect(fx.calls.at(-1)?.withPersonUid, "for that pair").toBe(AGENT);
    expect(replyRow(), "the reply has not landed yet").toBeNull();
    expect(
      thinkingRow(),
      "the indicator survives until the reply is on screen",
    ).toBeTruthy();

    fx.pending = null;
    held.release();
    await settle(20);

    expect(replyRow()?.textContent, "the reply is rendered").toContain(
      "Here is the long thing you asked for",
    );
    expect(thinkingRow(), "and only now does the row end").toBeNull();
  });

  it("clears a DM row that is not open without fetching its timeline", async () => {
    const fx = fixture();
    const wakes = await mountApp(fx);
    await sendPlainMessage();
    expect(thinkingRow()).toBeTruthy();

    await openRow(ROW_B_ID);
    const before = fx.calls.length;
    fx.dm = [REPLY];

    wakes.emit("dm:new-message", {
      fromPersonUid: AGENT,
      eventId: REPLY.eventId,
      createdAt: REPLY_AT,
      direction: "in",
    });
    await settle(10);

    expect(fx.calls.length, "a closed DM is not fetched").toBe(before);

    await openRow(DM_ROW.id);
    expect(thinkingRow(), "the wake ended the closed row").toBeNull();
  });

  it("keeps the thinking row up when the refresh fails", async () => {
    const fx = fixture();
    const wakes = await mountApp(fx);
    await sendPlainMessage();
    expect(thinkingRow()).toBeTruthy();

    fx.failDm = true;
    wakes.emit("dm:new-message", {
      fromPersonUid: AGENT,
      eventId: REPLY.eventId,
      createdAt: REPLY_AT,
      direction: "in",
    });
    await settle(20);

    expect(replyRow(), "nothing to show").toBeNull();
    expect(
      thinkingRow(),
      "a failed fetch must not strand the user with neither",
    ).toBeTruthy();
  });
});
