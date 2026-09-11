// @vitest-environment happy-dom

/**
 * The @mention picker must offer everyone already on the open channel's
 * roster — including a teammate's personal bot, which is never on the
 * company contacts list (it has no membership). Live bug (2026-09-11): a
 * teammate opened a channel with the owner's bot on the roster, typed
 * "@claude-bot", and the picker said "No one matches".
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

const NOW = new Date().toISOString();

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      // Company contacts: only a human teammate. The bot is NOT here.
      listContacts: async () =>
        ok({ contacts: [{ personUid: "prs_jacob", displayName: "Jacob" }] }),
      // Channel roster (GET /channels/{id}/members): the bot IS here.
      listChannelMembers: async () =>
        ok({
          members: [
            { personUid: "prs_me", displayName: "Corey", role: "owner" },
            { personUid: "prs_jacob", displayName: "Jacob", role: "member" },
            { personUid: "agt_claudebot", displayName: "claude-bot", role: "agent" },
          ],
        }),
      fetchChannel: async () => ok({ messages: [] }),
      fetchDmThread: async () => ok({ messages: [] }),
      sendChannelMessage: async () =>
        ok({ eventId: "evt_1", createdAt: new Date().toISOString() }),
      sendDm: async () =>
        ok({ eventId: "evt_2", createdAt: new Date().toISOString() }),
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
          type: "company",
          scope: "company",
          companyUid: "cmp_indigo",
          name: "bots-test",
          subtitle: "company",
          lastActivityAt: NOW,
          unreadCount: 0,
          memberCount: 3,
        },
      ],
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
  title: "bots-test",
  channelId: "chn_a",
  companyUid: "cmp_indigo",
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
  await settle(12);
}

function pickerLabels(): string[] {
  return [...host.querySelectorAll('[data-testid="mention-picker"] button')].map(
    (b) => b.textContent?.trim() ?? "",
  );
}

describe("DesktopApp @mention picker includes the channel roster", () => {
  it("offers a personal bot that is on the roster but not in contacts", async () => {
    await mountApp();
    const el = host.querySelector<HTMLTextAreaElement>(
      '[data-testid="conversation-composer"]',
    );
    expect(el, "composer mounted").toBeTruthy();
    el!.value = "@claude";
    el!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const labels = pickerLabels();
    expect(labels.some((l) => l.includes("claude-bot")), labels.join(" | ")).toBe(true);
  });

  it("still offers company contacts alongside roster members", async () => {
    await mountApp();
    const el = host.querySelector<HTMLTextAreaElement>(
      '[data-testid="conversation-composer"]',
    )!;
    el.value = "@ja";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(pickerLabels().some((l) => l.includes("Jacob"))).toBe(true);
  });
});
