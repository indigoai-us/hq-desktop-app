// @vitest-environment happy-dom

/**
 * Reopening a conversation must paint its cached rows in the same tick.
 *
 * The shell used to clear the timeline on every switch and mount the cached
 * rows a frame later. That guaranteed one painted frame with an empty pane
 * between the two conversations — the flash, and the "settle", behind the
 * reported layout shift: blank, then rows, then the list dropping to the
 * bottom.
 *
 * The test pins the property rather than the implementation: with
 * `requestAnimationFrame` stubbed out entirely, reopening a visited
 * conversation still shows its messages. Under the old code nothing painted at
 * all, because the only path to the rows ran inside the frame callback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus, type ChatSidebarApi } from "../chat/chat-api.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import { takePendingChannelOpen } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

const NOW = new Date().toISOString();

function message(channelId: string) {
  return {
    eventId: `${channelId}-1`,
    fromPersonUid: "prs_ada",
    fromDisplayName: "Ada Lovelace",
    body: `only in ${channelId}`,
    createdAt: NOW,
    direction: "in",
  };
}

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async ({ channelId }: { channelId: string }) =>
        ok({ messages: [message(channelId)] }),
      fetchDmThread: async () => ok({ messages: [] }),
      sendChannelMessage: async () =>
        ok({ eventId: "evt_sent", createdAt: NOW }),
      sendDm: async () => ok({ eventId: "evt_sent", createdAt: NOW }),
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

function channel(channelId: string, name: string) {
  return {
    channelId,
    type: "project",
    scope: "project",
    companyUid: null,
    name,
    subtitle: "project",
    lastActivityAt: NOW,
    unreadCount: 0,
    memberCount: 2,
  };
}

function sidebarApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      contractVersion: 2,
      snapshot: true,
      cursor: "cursor00000000000000000000000000000000000",
      cursorExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      rows: [channel("chn_a", "alpha"), channel("chn_b", "beta")],
    }),
    listContacts: async () => ({ contacts: [] }),
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

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function resetSharedState(): void {
  window.localStorage?.clear?.();
  takePendingConversation();
  takePendingChannelOpen();
}

beforeEach(resetSharedState);

afterEach(async () => {
  vi.unstubAllGlobals();
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetSharedState();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountApp(): Promise<void> {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(),
      sidebarApi: sidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      initialRow: ROW_A,
      wakes: createChatWakeBus(),
      coreFixtures: false,
    },
  });
  await settle();
}

async function openRow(rowId: string): Promise<void> {
  let button: HTMLButtonElement | null = null;
  for (let i = 0; i < 20 && !button; i += 1) {
    button = host.querySelector<HTMLButtonElement>(
      `[data-conversation-id="${rowId}"]`,
    );
    if (!button) await settle(2);
  }
  expect(button, `rail row ${rowId}`).toBeTruthy();
  button!.click();
  await settle(12);
}

function threadText(): string {
  return (
    host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? ""
  );
}

describe("DesktopApp conversation switch paints without a frame", () => {
  it("reopens a visited conversation from cache with no animation frame", async () => {
    await mountApp();
    await expect.poll(threadText).toContain("only in chn_a");

    // Cold open: chn_b has nothing cached, so its rows arrive with the fetch.
    // This first visit exists to populate the cache the assertion below needs.
    await openRow("ch:chn_b");
    await expect.poll(threadText).toContain("only in chn_b");

    // From here no frame callback ever runs. Anything that needs one to paint
    // will not paint.
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});

    // Reopening a VISITED conversation must paint in the same tick. With no
    // frame callback available the cached rows are the only thing that can
    // appear, so a synchronous assertion is the property under test.
    await openRow("ch:chn_a");
    expect(threadText()).toContain("only in chn_a");
    expect(threadText()).not.toContain("only in chn_b");
  });

  it("wraps the conversation in the cross-fade layer", async () => {
    await mountApp();
    await expect.poll(threadText).toContain("only in chn_a");

    // The fade is opacity-only and lives on this element. If the conversation
    // stops being wrapped, the switch loses its transition silently.
    const layer = host.querySelector(".conversation-layer");
    expect(layer).toBeTruthy();
    expect(layer!.querySelector('[data-testid="conversation-view"]')).toBeTruthy();
  });
});
