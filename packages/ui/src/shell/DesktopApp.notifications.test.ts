// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import type { NotificationsApi } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

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
  } as unknown as PlatformAdapter;
}

const projectRow: ConversationRow = {
  id: "ch:chn_proj",
  kind: "channel",
  title: "work-mesh-testing",
  companyUid: "cmp_acme",
  unreadDot: false,
  lastActivityAt: Date.parse("2026-08-23T00:00:00.000Z"),
  pinned: false,
  channelId: "chn_proj",
};

function unreadApi(unread: { n: number }): NotificationsApi {
  return {
    fetchNotifications: async () => ({
      notifications:
        unread.n > 0
          ? [
              {
                id: "n-dm",
                type: "dm",
                status: "unread",
                createdAt: "2026-08-23T15:00:00.000Z",
                actorName: "Deacon",
                body: "hello",
              },
            ]
          : [],
      unreadCount: unread.n,
      nextCursor: null,
    }),
    ackNotification: async () => {},
    readAllNotifications: async () => {
      unread.n = 0;
    },
    runNotificationAction: async () => ({}),
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("DesktopApp notifications bell", () => {
  it("lights the bell while a channel is open (panel stays mounted)", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const unread = { n: 1 };
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: webAdapter(),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: unreadApi(unread),
        initialRow: projectRow,
        searchRows: [projectRow],
        self: { uid: "prs_test", displayName: "Stefan", email: "s@x.y" },
        coreFixtures: false,
      },
    });
    await tick();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="titlebar-notifications-badge"]'),
      ).toBeTruthy();
    });
    expect(
      host.querySelector('[data-testid="notifications-view"]'),
    ).toBeTruthy();
    expect(host.querySelector(".notifications-layer.is-active")).toBeNull();
  });

  it("keeps mark-all-read after leaving the panel", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const unread = { n: 1 };
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: webAdapter(),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: unreadApi(unread),
        initialRow: projectRow,
        searchRows: [projectRow],
        self: { uid: "prs_test", displayName: "Stefan", email: "s@x.y" },
        coreFixtures: false,
      },
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="titlebar-notifications-badge"]'),
      ).toBeTruthy();
    });
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="titlebar-notifications"]',
      )
      ?.click();
    await tick();
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="notifications-mark-all-read"]',
      )
      ?.click();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="titlebar-notifications-badge"]'),
      ).toBeNull();
    });
    host
      .querySelector<HTMLButtonElement>('[data-testid="notifications-back"]')
      ?.click();
    await tick();
    expect(
      host.querySelector('[data-testid="titlebar-notifications-badge"]'),
    ).toBeNull();
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="titlebar-notifications"]',
      )
      ?.click();
    await tick();
    expect(
      host.querySelector('[data-testid="notifications-unread"]')?.textContent,
    ).toContain("All caught up");
  });
});
