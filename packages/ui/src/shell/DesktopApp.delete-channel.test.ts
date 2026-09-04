// @vitest-environment happy-dom

/**
 * Owner deletes a channel from the members popover: trash → shell confirm →
 * adapter.deleteChannel → optimistic `channel:removed` wake + cleared
 * selection. Failures surface as a visible alert under the header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import { takePendingChannelOpen } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

const SELF = { uid: "prs_me", displayName: "Ada Lovelace", email: "ada@x.y" };

function roster(selfRole: "owner" | "member") {
  return {
    members: [
      {
        personUid: "prs_me",
        displayName: "Ada Lovelace",
        role: selfRole,
        email: "ada@x.y",
      },
      {
        personUid: "prs_other",
        displayName: "Marcus Chen",
        role: selfRole === "owner" ? "member" : "owner",
        email: "marcus@x.y",
      },
    ],
  };
}

function adapter(
  messaging: Partial<PlatformAdapter["messaging"]> = {},
): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok(roster("owner")),
      deleteChannel: async () => ok({ deleted: "chn_proj" }),
      ...messaging,
    },
  } as unknown as PlatformAdapter;
}

const channelRow: ConversationRow = {
  id: "ch:chn_proj",
  kind: "channel",
  title: "launch",
  companyUid: "cmp_acme",
  unreadDot: false,
  lastActivityAt: Date.parse("2026-08-23T00:00:00.000Z"),
  pinned: false,
  channelId: "chn_proj",
  channelScope: "company",
  memberCount: 2,
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

// The sidebar persists its conversation cache, and `openRow` (incl. the
// US-016 auto-open after a cleared selection) stashes module-level pending
// channel / DM targets that the next mount would consume — drain them all so
// one test's rail state cannot pick the next test's selection.
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
  messaging: Partial<PlatformAdapter["messaging"]> = {},
  wakes = createChatWakeBus(),
) {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(messaging),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      initialRow: channelRow,
      searchRows: [channelRow],
      wakes,
      self: SELF,
      coreFixtures: false,
    },
  });
  await settle();
  return wakes;
}

async function openPopover(): Promise<void> {
  const pill = host.querySelector<HTMLButtonElement>(
    '[data-testid="channel-members"]',
  );
  expect(
    host.querySelector('[data-testid="channel-name"]')?.textContent,
    "#launch is the selected conversation",
  ).toBe("launch");
  expect(pill, "member pill renders for the selected channel").toBeTruthy();
  pill!.click();
  await settle();
  expect(
    host.querySelector('[data-testid="channel-status-popover"]'),
  ).toBeTruthy();
}

describe("DesktopApp delete channel", () => {
  it("owner: trash → confirm → deleteChannel called, wake emitted, selection cleared", async () => {
    const deleteChannel = vi.fn(async () => ok({ deleted: "chn_proj" }));
    const wakes = await mountApp({ deleteChannel });
    const removed: string[] = [];
    wakes.on("channel:removed", ({ channelId }) => removed.push(channelId));

    expect(host.querySelector('[data-testid="channel-header"]')).toBeTruthy();
    await openPopover();

    const trash = host.querySelector<HTMLButtonElement>(
      '[data-testid="status-channel-delete"]',
    );
    expect(trash, "owner sees the trash control").toBeTruthy();
    trash!.click();
    await settle();

    // Popover closed; the shell-owned confirm is up and nothing was called yet.
    expect(
      host.querySelector('[data-testid="channel-status-popover"]'),
    ).toBeNull();
    const dialog = document.querySelector('[data-testid="confirm-dialog"]');
    expect(dialog, "confirm dialog renders").toBeTruthy();
    expect(dialog?.textContent).toContain("Delete #launch?");
    expect(dialog?.textContent).toContain("This can't be undone.");
    expect(deleteChannel).not.toHaveBeenCalled();

    document
      .querySelector<HTMLButtonElement>('[data-testid="confirm-dialog-ok"]')!
      .click();
    await settle();

    expect(deleteChannel).toHaveBeenCalledTimes(1);
    expect(deleteChannel).toHaveBeenCalledWith("chn_proj");
    expect(removed).toEqual(["chn_proj"]);
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    // The deleted channel is no longer the selection. (The shell clears it;
    // the sidebar's US-016 rule may then auto-open the newest remaining row,
    // so assert "not #launch" rather than "no header".)
    expect(
      host.querySelector('[data-testid="channel-name"]')?.textContent ?? null,
    ).not.toBe("launch");
    // …and its rail row dropped optimistically via the wake.
    expect(host.querySelector('[data-conversation-id="ch:chn_proj"]')).toBeNull();
    expect(host.querySelector('[data-testid="channel-action-error"]')).toBeNull();
  });

  it("cancelling the confirm keeps the channel and never calls the adapter", async () => {
    const deleteChannel = vi.fn(async () => ok({ deleted: "chn_proj" }));
    await mountApp({ deleteChannel });
    await openPopover();
    host
      .querySelector<HTMLButtonElement>('[data-testid="status-channel-delete"]')!
      .click();
    await settle();
    const cancel = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="confirm-dialog"] button',
      ),
    ].find((b) => b.textContent?.trim() === "Cancel");
    expect(cancel).toBeTruthy();
    cancel!.click();
    await settle();
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(deleteChannel).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="channel-header"]')).toBeTruthy();
  });

  it("surfaces an adapter failure as a visible alert and keeps the selection", async () => {
    const deleteChannel = vi.fn(async () =>
      failure("http-404", "This server doesn't support deleting channels yet."),
    );
    const wakes = await mountApp({ deleteChannel });
    const removed: string[] = [];
    wakes.on("channel:removed", ({ channelId }) => removed.push(channelId));
    await openPopover();
    host
      .querySelector<HTMLButtonElement>('[data-testid="status-channel-delete"]')!
      .click();
    await settle();
    document
      .querySelector<HTMLButtonElement>('[data-testid="confirm-dialog-ok"]')!
      .click();
    await settle();

    expect(deleteChannel).toHaveBeenCalledWith("chn_proj");
    const alert = host.querySelector('[data-testid="channel-action-error"]');
    expect(alert, "error renders near the header").toBeTruthy();
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain(
      "This server doesn't support deleting channels yet.",
    );
    expect(removed).toEqual([]);
    expect(host.querySelector('[data-testid="channel-header"]')).toBeTruthy();
  });

  it("non-owner: no trash control in the popover", async () => {
    await mountApp({
      listChannelMembers: async () => ok(roster("member")),
    });
    await openPopover();
    expect(
      host.querySelector('[data-testid="status-channel-delete"]'),
    ).toBeNull();
  });
});
