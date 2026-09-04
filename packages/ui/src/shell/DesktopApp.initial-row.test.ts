// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopAppInitialRowHarness from "./DesktopAppInitialRowHarness.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

type InitialRowHarness = {
  updateInitialRow(next: ConversationRow | null): void;
};

function webAdapter(): PlatformAdapter {
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
    meetings: {
      listUpcoming: async () => ok([]),
      listMemberships: async () => ok([]),
      listAccounts: async () => ok([]),
      listScheduledBots: async () => ok([]),
    },
  } as unknown as PlatformAdapter;
}

const stub: ConversationRow = {
  id: "ch:chn_atlas",
  kind: "channel",
  title: "Loading conversation…",
  companyUid: null,
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
};

const enriched: ConversationRow = {
  ...stub,
  title: "Atlas",
  companyUid: "cmp_acme",
  channelId: "chn_atlas",
  channelScope: "project",
  projectId: "atlas",
  membership: "joined",
};

let host: HTMLDivElement;
let component: InitialRowHarness | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountHarness(filesByRow = vi.fn(() => [])): ReturnType<typeof vi.fn> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopAppInitialRowHarness, {
    target: host,
    props: {
      adapter: webAdapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      initialRow: stub,
      coreFixtures: false,
      filesByRow,
    },
  });
  return filesByRow;
}

describe("DesktopApp initial-row reconciliation", () => {
  it("upgrades the selected deep-link stub when the same conversation gains metadata", async () => {
    const filesByRow = mountHarness();
    await tick();

    component?.updateInitialRow(enriched);
    await tick();

    expect(host.querySelector("[data-testid='channel-name']")?.textContent).toBe(
      "Atlas",
    );
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Files")
      ?.click();
    await tick();
    expect(filesByRow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        companyUid: "cmp_acme",
        channelId: "chn_atlas",
        channelScope: "project",
        projectId: "atlas",
      }),
    );
  });

  it("does not replace an existing selection when a new initial row names another conversation", async () => {
    mountHarness();
    await tick();

    component?.updateInitialRow({
      ...enriched,
      id: "ch:chn_other",
      title: "Other project",
      channelId: "chn_other",
      projectId: "other",
    });
    await tick();

    expect(host.querySelector("[data-testid='channel-name']")?.textContent).toBe(
      "Loading conversation…",
    );
  });
});
