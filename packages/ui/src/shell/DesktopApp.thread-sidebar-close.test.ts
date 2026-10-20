// @vitest-environment happy-dom

/**
 * Drives DesktopApp closeReply: open thread A, then B, then the sidebar X.
 * Back and Forward must match the history left after the stack is dropped.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import {
  requestChannelOpen,
  takePendingChannelOpen,
} from "../chat/open-target";
import { takePendingConversation } from "../chat/pending-conversation";
import type { ChatSidebarApi, NotificationsApi } from "../chat/chat-api";
import type { ConversationRow } from "../chat/sidebar-model";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const channelRow: ConversationRow = {
  id: "ch:chn_proj",
  kind: "channel",
  title: "launch",
  companyUid: "cmp_acme",
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  channelId: "chn_proj",
  channelScope: "project",
};

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  takePendingChannelOpen();
  takePendingConversation();
  window.history.replaceState({}, "", "/");
});

function emptyDirectoryFeed() {
  return {
    snapshot: true,
    cursor: "c1",
    cursorExpiresAt: "2099-01-01T00:00:00.000Z",
    rows: [],
  };
}

function sidebarApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => emptyDirectoryFeed(),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => ({ channels: [] }),
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
    logToFile: async () => {},
    ensureCompanyHomeChannel: async (companyUid: string) => ({
      homeChannelId: `chn_home_${companyUid}`,
    }),
  };
}

function notificationsApi(): NotificationsApi {
  return {
    fetchNotifications: async () => ({ notifications: [], unreadCount: 0 }),
    ackNotification: async () => {},
    readAllNotifications: async () => {},
    runNotificationAction: async () => ({}),
  };
}

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    messaging: {
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      fetchReplyThread: async (args: { rootEventId: string }) =>
        ok({
          scope: "channel",
          root: {
            eventId: args.rootEventId,
            body: args.rootEventId,
            createdAt: "2026-08-17T01:00:00.000Z",
            fromDisplayName: "Ada",
            replyCount: 0,
          },
          replies: [],
          replyCount: 0,
        }),
      sendReply: async () => ok({}),
      sendChannelMessage: async () => ok(undefined),
      sendDm: async () => ok(undefined),
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      toggleReaction: async () => ok(undefined),
    },
  } as unknown as PlatformAdapter;
}

describe("DesktopApp thread sidebar close", () => {
  it("closeReply closes A then B and leaves Back and Forward matching the closed history", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: adapter(),
        sidebarApi: sidebarApi(),
        notificationsApi: notificationsApi(),
        initialRow: channelRow,
        searchRows: [channelRow],
        hydrateLiveMessages: true,
      },
    });
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="channel-name"]')?.textContent).toBe(
        "launch",
      );
    });

    requestChannelOpen("chn_proj", { replyRootEventId: "evt_a" });
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector("[data-testid=reply-column]")).not.toBeNull();
    });
    requestChannelOpen("chn_proj", { replyRootEventId: "evt_b" });
    await tick();
    await vi.waitFor(() => {
      expect(
        host.querySelector("[data-testid=reply-panel]")?.getAttribute("data-root-event-id"),
      ).toBe("evt_b");
    });

    (
      host.querySelector(
        '[data-testid="reply-column"] [aria-label="Close"]',
      ) as HTMLButtonElement
    ).click();
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector("[data-testid=reply-column]")).toBeNull();
    });

    const back = host.querySelector(
      '[data-testid="titlebar-back"]',
    ) as HTMLButtonElement;
    const forward = host.querySelector(
      '[data-testid="titlebar-forward"]',
    ) as HTMLButtonElement;
    expect(back).not.toBeNull();
    expect(forward).not.toBeNull();
    expect(forward.disabled, "forward must not walk into a duplicate").toBe(true);
    expect(back.disabled, "close leaves a single conversation entry").toBe(true);

    back.click();
    forward.click();
    await tick();
    expect(host.querySelector("[data-testid=reply-column]")).toBeNull();
  });
});
