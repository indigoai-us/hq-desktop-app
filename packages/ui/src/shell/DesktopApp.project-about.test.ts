// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import type { NotificationsApi } from "../chat/chat-api.js";
import type { ChannelStatusModel } from "../chat/channel-status-model.js";
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
  channelScope: "project",
};

const status: ChannelStatusModel = {
  liveAgents: [],
  activeSessions: [],
  stories: { complete: 0, total: 0, label: "stories 0/0", percent: 0 },
  project: {
    branch: null,
    repo: null,
    repos: [],
    previewUrl: null,
    description: "Live board for HQ Work mesh.",
  },
  members: [],
  agents: [],
  memberCount: 0,
  companyLabel: "Acme",
};

function emptyNotifications(): NotificationsApi {
  return {
    fetchNotifications: async () => ({
      notifications: [],
      unreadCount: 0,
      nextCursor: null,
    }),
    ackNotification: async () => {},
    readAllNotifications: async () => {},
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

describe("DesktopApp project about", () => {
  it("opens a description dialog from the channel-header info control", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: webAdapter(),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: emptyNotifications(),
        initialRow: projectRow,
        searchRows: [projectRow],
        channelStatusByRow: () => status,
        self: { uid: "prs_test", displayName: "Stefan", email: "s@x.y" },
        coreFixtures: false,
      },
    });
    await tick();
    const info = host.querySelector(
      '[data-testid="project-about"]',
    ) as HTMLButtonElement | null;
    expect(info).toBeTruthy();
    info?.click();
    await tick();
    expect(
      host.querySelector("[data-testid='project-about-body']")?.textContent,
    ).toBe("Live board for HQ Work mesh.");
  });
});
