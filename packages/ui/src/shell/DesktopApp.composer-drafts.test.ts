// @vitest-environment happy-dom

/**
 * Slack-style composer drafts across conversation switches: the shell keys
 * `ChannelConversation` on the selected row (remount per switch), so unsent
 * text must round-trip through the tenant draft store — type in A, open B,
 * come back to A → the text is still there, and the rail marks A as a draft.
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

const SELF = { uid: "prs_me", displayName: "Ada Lovelace", email: "ada@x.y" };

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok({ members: [] }),
    },
  } as unknown as PlatformAdapter;
}

// Both rows exist in the fixture directory the rail renders.
const rowA: ConversationRow = {
  id: "ch:hq-desktop",
  kind: "channel",
  title: "hq-desktop",
  companyUid: null,
  unreadDot: false,
  lastActivityAt: Date.now(),
  pinned: false,
  channelId: "hq-desktop",
  channelScope: "project",
};
const ROW_B_ID = "ch:hq-sync";

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
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      initialRow: rowA,
      searchRows: [rowA],
      wakes: createChatWakeBus(),
      self: SELF,
      coreFixtures: false,
      // A real tenant so `tenantStorage` is not the no-op facade.
      tenantAccountId: "acct_test",
    },
  });
  await settle();
}

function composer(): HTMLTextAreaElement {
  const el = host.querySelector<HTMLTextAreaElement>(
    '[data-testid="conversation-composer"]',
  );
  expect(el, "composer is mounted").toBeTruthy();
  return el!;
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
  await settle();
}

describe("DesktopApp composer drafts", () => {
  it("keeps unsent text when switching away and back, and marks the row", async () => {
    await mountApp();
    expect(host.querySelector('[data-testid="channel-name"]')?.textContent).toBe(
      "hq-desktop",
    );

    const first = composer();
    first.value = "brb, half a thought";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    // Switch to B before the debounce fires — the unmount must flush.
    await openRow(ROW_B_ID);
    expect(host.querySelector('[data-testid="channel-name"]')?.textContent).toBe(
      "hq-sync",
    );
    expect(composer().value, "B starts empty").toBe("");
    expect(
      host
        .querySelector(`[data-conversation-id="${rowA.id}"]`)
        ?.querySelector('[data-testid="chat-row-draft"]'),
      "rail marks A as having a draft",
    ).toBeTruthy();
    expect(
      host
        .querySelector(`[data-conversation-id="${ROW_B_ID}"]`)
        ?.querySelector('[data-testid="chat-row-draft"]'),
    ).toBeNull();

    // Back to A → the draft is restored into the composer.
    await openRow(rowA.id);
    expect(host.querySelector('[data-testid="channel-name"]')?.textContent).toBe(
      "hq-desktop",
    );
    expect(composer().value).toBe("brb, half a thought");
  });
});
