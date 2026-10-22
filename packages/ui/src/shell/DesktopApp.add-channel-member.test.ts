// @vitest-environment happy-dom

/**
 * Owner adds a teammate or one of their own bots to a channel from the
 * members popover "+ Add" row: candidate click → adapter.addChannelMember →
 * roster reload with the popover still open. A 403 CHANNEL_NOT_MEMBER (the
 * caller is browsing a company channel without having joined) self-joins
 * first and retries once. Failures show a plain sentence inline, never a
 * machine code or transport dump.
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

const SELF = { uid: "prs_me", displayName: "Josh Owner", email: "josh@x.y" };

function roster(extra: Array<Record<string, unknown>> = []) {
  return {
    members: [
      { personUid: "prs_me", displayName: "Josh Owner", role: "owner" },
      { personUid: "prs_in", displayName: "Already In", role: "member" },
      ...extra,
    ],
  };
}

const CONTACTS = {
  contacts: [
    { personUid: "prs_me", displayName: "Josh Owner" },
    { personUid: "prs_in", displayName: "Already In" },
    { personUid: "prs_amy", displayName: "Amy Lee", email: "amy@x.y" },
  ],
};

function adapter(
  messaging: Partial<PlatformAdapter["messaging"]> = {},
): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok(CONTACTS),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok(roster()),
      addChannelMember: async () => ok({ member: {}, alreadyMember: false }),
      removeChannelMember: async () => ok({ removed: "prs_me" }),
      ...messaging,
    },
    bots: {
      list: async () => ok({ bots: [] }),
      listRemote: async () =>
        ok({
          bots: [
            {
              name: "jimbo",
              displayName: "Jimbo",
              agentUid: "agt_jimbo",
              kind: "personal",
              online: true,
              lastHeartbeatAt: null,
              here: false,
              settings: "",
            },
          ],
        }),
    },
  } as unknown as PlatformAdapter;
}

const channelRow: ConversationRow = {
  id: "ch:chn_ads",
  kind: "channel",
  title: "google-ads",
  companyUid: "cmp_soar",
  unreadDot: false,
  lastActivityAt: Date.parse("2026-10-20T00:00:00.000Z"),
  pinned: false,
  channelId: "chn_ads",
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

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountApp(
  messaging: Partial<PlatformAdapter["messaging"]> = {},
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
      wakes: createChatWakeBus(),
      self: SELF,
      coreFixtures: false,
    },
  });
  await settle();
}

async function openAddList(): Promise<HTMLElement[]> {
  host.querySelector<HTMLButtonElement>('[data-testid="channel-members"]')!.click();
  await settle();
  expect(host.querySelector('[data-testid="channel-status-popover"]')).toBeTruthy();
  const add = host.querySelector<HTMLButtonElement>('[data-testid="status-member-add"]');
  expect(add, "+ Add row is offered").toBeTruthy();
  add!.click();
  await settle();
  return [...host.querySelectorAll<HTMLElement>('[data-testid="status-add-candidate"]')];
}

describe("DesktopApp add channel member (+ Add in the members popover)", () => {
  it("offers own bots and company teammates who are not members yet, bots first", async () => {
    await mountApp();
    const rows = await openAddList();
    expect(rows.map((r) => r.dataset.uid)).toEqual(["agt_jimbo", "prs_amy"]);
    expect(rows[0].textContent).toContain("Jimbo");
    expect(rows[1].textContent).toContain("Amy Lee");
  });

  it("success: calls addChannelMember, reloads the roster, keeps the popover open", async () => {
    let added = false;
    const addChannelMember = vi.fn(async () => {
      added = true;
      return ok({ member: { personUid: "agt_jimbo" }, alreadyMember: false });
    });
    const listChannelMembers = vi.fn(async () =>
      ok(
        added
          ? roster([{ personUid: "agt_jimbo", displayName: "Jimbo", role: "agent" }])
          : roster(),
      ),
    );
    await mountApp({ addChannelMember, listChannelMembers });
    const rows = await openAddList();
    rows[0].click();
    await settle(12);

    expect(addChannelMember).toHaveBeenCalledTimes(1);
    expect(addChannelMember).toHaveBeenCalledWith("chn_ads", "agt_jimbo");
    expect(host.querySelector('[data-testid="channel-status-popover"]')).toBeTruthy();
    // The bot moved from the add list to the BOTS roster.
    expect(
      [...host.querySelectorAll<HTMLElement>('[data-testid="status-add-candidate"]')].map(
        (r) => r.dataset.uid,
      ),
    ).toEqual(["prs_amy"]);
    expect(
      [...host.querySelectorAll('[data-testid="status-agent"]')].some((r) =>
        r.textContent?.includes("Jimbo"),
      ),
    ).toBe(true);
    expect(host.querySelector('[data-testid="status-add-error"]')).toBeNull();
  });

  it("403 CHANNEL_NOT_MEMBER: joins the channel first, then retries the add once", async () => {
    const calls: string[] = [];
    const addChannelMember = vi.fn(async (_channelId: string, uid: string) => {
      calls.push(uid);
      if (calls.length === 1) {
        return failure("CHANNEL_NOT_MEMBER", "Join the channel before adding members");
      }
      return ok({ member: { personUid: uid }, alreadyMember: false });
    });
    await mountApp({ addChannelMember });
    const rows = await openAddList();
    rows[1].click();
    await settle(12);

    expect(calls).toEqual(["prs_amy", "prs_me", "prs_amy"]);
    expect(host.querySelector('[data-testid="status-add-error"]')).toBeNull();
  });

  it("failure: shows the server sentence inline, never the code", async () => {
    const addChannelMember = vi.fn(async () =>
      failure("INVITEE_NOT_FOUND", "That person is not in HQ"),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mountApp({ addChannelMember });
    const rows = await openAddList();
    rows[1].click();
    await settle(12);

    const err = host.querySelector('[data-testid="status-add-error"]');
    expect(err?.textContent).toContain("That person is not in HQ.");
    expect(err?.textContent).not.toContain("INVITEE_NOT_FOUND");
    expect(host.querySelector('[data-testid="channel-status-popover"]')).toBeTruthy();
    warn.mockRestore();
  });

  it("failure with only a code or transport text gets fixed copy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const addChannelMember = vi.fn(async () =>
      failure("http-500", '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}'),
    );
    await mountApp({ addChannelMember });
    const rows = await openAddList();
    rows[1].click();
    await settle(12);

    const err = host.querySelector('[data-testid="status-add-error"]');
    expect(err?.textContent).toContain("Couldn't add Amy Lee. Try again.");
    expect(err?.textContent).not.toContain("boom");
    expect(err?.textContent).not.toContain("http-500");
    warn.mockRestore();
  });

  it("ignores a second click while the first add is in flight", async () => {
    let release: (() => void) | null = null;
    const addChannelMember = vi.fn(
      () =>
        new Promise<ReturnType<typeof ok>>((resolve) => {
          release = () => resolve(ok({ member: {}, alreadyMember: false }));
        }),
    );
    await mountApp({ addChannelMember });
    const rows = await openAddList();
    rows[0].click();
    await settle();
    rows[0].click();
    rows[1].click();
    await settle();
    expect(addChannelMember).toHaveBeenCalledTimes(1);
    expect(rows[0].textContent).toContain("…");
    release?.();
    await settle(12);
  });
});
