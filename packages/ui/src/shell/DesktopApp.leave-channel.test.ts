// @vitest-environment happy-dom

/**
 * Member self-leaves a channel from the members popover: X on own row →
 * adapter.removeChannelMember → optimistic `channel:removed` wake + cleared
 * selection + closed popover. Failures surface as a visible alert under the
 * header and leave the rail row in place.
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

function memberRoster() {
  return {
    members: [
      {
        personUid: "prs_me",
        displayName: "Ada Lovelace",
        role: "member",
        email: "ada@x.y",
      },
      {
        personUid: "prs_owner",
        displayName: "Marcus Chen",
        role: "owner",
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
      listChannelMembers: async () => ok(memberRoster()),
      removeChannelMember: async () => ok({ removed: "prs_me" }),
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
  expect(pill).toBeTruthy();
  pill!.click();
  await settle();
  expect(
    host.querySelector('[data-testid="channel-status-popover"]'),
  ).toBeTruthy();
}

describe("DesktopApp leave channel (self-remove)", () => {
  it.each(["missing", "null"] as const)(
    "does not offer Leave when the parsed roster has a %s caller role",
    async (roleShape) => {
      const roster = {
        members: [
          {
            personUid: "prs_me",
            displayName: "Ada Lovelace",
            ...(roleShape === "null" ? { role: null } : {}),
          },
          {
            personUid: "prs_owner",
            displayName: "Marcus Chen",
            role: "owner",
          },
        ],
      };
      await mountApp({ listChannelMembers: async () => ok(roster) });

      await openPopover();

      const selfRow = [...host.querySelectorAll<HTMLElement>(
        '[data-testid="status-member"]',
      )].find((row) => row.textContent?.includes("Ada Lovelace"));
      expect(selfRow, "parsed caller roster row is visible").toBeTruthy();
      expect(
        selfRow?.querySelector('[data-testid="status-member-remove"]'),
      ).toBeNull();
    },
  );

  it("success: emits channel:removed, drops the rail row, clears selection, closes popover", async () => {
    const removeChannelMember = vi.fn(async () => ok({ removed: "prs_me" }));
    const wakes = await mountApp({ removeChannelMember });
    const removed: string[] = [];
    wakes.on("channel:removed", ({ channelId }) => removed.push(channelId));

    await openPopover();
    const selfRemove = host.querySelector<HTMLButtonElement>(
      '[data-testid="status-member-remove"]',
    );
    expect(selfRemove, "member sees their own leave X").toBeTruthy();
    selfRemove!.click();
    await settle();

    expect(removeChannelMember).toHaveBeenCalledWith("chn_proj", "prs_me");
    expect(removed).toEqual(["chn_proj"]);
    expect(
      host.querySelector('[data-testid="channel-status-popover"]'),
    ).toBeNull();
    expect(
      host.querySelector('[data-conversation-id="ch:chn_proj"]'),
    ).toBeNull();
    expect(
      host.querySelector('[data-testid="channel-name"]')?.textContent ?? null,
    ).not.toBe("launch");
    expect(host.querySelector('[data-testid="channel-action-error"]')).toBeNull();
  });

  it("failure: shows a safe retry message and keeps the rail row + selection", async () => {
    const removeChannelMember = vi.fn(async () =>
      failure("http-403", "You can't leave this channel."),
    );
    const wakes = await mountApp({ removeChannelMember });
    const removed: string[] = [];
    wakes.on("channel:removed", ({ channelId }) => removed.push(channelId));

    await openPopover();
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="status-member-remove"]',
      )!
      .click();
    await settle();

    expect(removeChannelMember).toHaveBeenCalledWith("chn_proj", "prs_me");
    expect(removed).toEqual([]);
    const alert = host.querySelector('[data-testid="channel-action-error"]');
    expect(alert, "error surfaces near the header").toBeTruthy();
    expect(alert?.textContent).toContain(
      "Couldn't leave this channel. Refresh and try again.",
    );
    // Selection preserved — header still shows #launch.
    expect(host.querySelector('[data-testid="channel-header"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="channel-name"]')?.textContent,
    ).toBe("launch");
  });

  it("handles a stale owner-role 409 with a clear message and no raw error", async () => {
    const removeChannelMember = vi.fn(async () =>
      failure("invoke", "CHANNEL_OWNER_CANNOT_LEAVE"),
    );
    await mountApp({ removeChannelMember });

    await openPopover();
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="status-member-remove"]',
      )!
      .click();
    await settle();

    const alert = host.querySelector('[data-testid="channel-action-error"]');
    expect(alert?.textContent).toContain(
      "Channel owners can't leave their own channel.",
    );
    expect(alert?.textContent).not.toContain("CHANNEL_OWNER_CANNOT_LEAVE");
    expect(host.querySelector('[data-testid="channel-header"]')).toBeTruthy();
  });
});
