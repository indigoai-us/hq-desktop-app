// @vitest-environment happy-dom

/**
 * Chat-stage reply-column layout: data-reply-open + column (wide viewport).
 *
 * happy-dom default width is wide, so the pane is a sibling column rather
 * than the narrow overlay. Assertions stay on classes/attributes — not
 * computed styles.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";

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

const root = {
  eventId: "evt_root",
  body: "root body",
  createdAt: "2026-08-17T01:00:00.000Z",
  fromDisplayName: "Ada",
  replyCount: 1,
};

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  takePendingChannelOpen();
  takePendingConversation();
  window.history.replaceState({}, "", "/");
  vi.useRealTimers();
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

function adapter(options: {
  thread?: unknown;
  threadError?: { code?: string; message?: string };
}): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    messaging: {
      fetchChannel: async () =>
        ok({
          messages: [root],
          nextCursor: null,
        }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      fetchReplyThread: async () => {
        if (options.threadError) {
          return failure(
            options.threadError.code ?? "THREAD_NOT_FOUND",
            options.threadError.message ?? "not found",
          );
        }
        return ok(
          options.thread ?? {
            scope: "channel",
            root,
            replies: [],
            replyCount: 1,
          },
        );
      },
      sendReply: async () => ok({}),
      sendChannelMessage: async () => ok(undefined),
      sendDm: async () => ok(undefined),
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      toggleReaction: async () => ok(undefined),
    },
  } as unknown as PlatformAdapter;
}

async function mountShell(
  props: Record<string, unknown> = {},
  fetchOpts: Parameters<typeof adapter>[0] = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(fetchOpts),
      sidebarApi: sidebarApi(),
      notificationsApi: notificationsApi(),
      initialRow: channelRow,
      searchRows: [channelRow],
      hydrateLiveMessages: true,
      ...props,
    },
  });
  await tick();
}

describe("DesktopApp reply-column layout", () => {
  it("toggles data-reply-open and mounts the sibling column at a wide viewport", async () => {
    await mountShell({ initialReplyRootEventId: null });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="channel-name"]')?.textContent,
      ).toBe("launch");
    });

    const stage = host.querySelector('[data-testid="chat-stage"]');
    expect(stage).not.toBeNull();
    expect(stage?.getAttribute("data-reply-open")).toBe("false");
    expect(host.querySelector("[data-testid=reply-column]")).toBeNull();

    requestChannelOpen("chn_proj", { replyRootEventId: "evt_root" });
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector("[data-testid=reply-column]")).not.toBeNull();
    });

    const column = host.querySelector("[data-testid=reply-column]");
    expect(column?.getAttribute("data-reply-layout")).toBe("column");
    expect(
      host
        .querySelector('[data-testid="chat-stage"]')
        ?.getAttribute("data-reply-open"),
    ).toBe("true");

    (
      host.querySelector(
        '[data-testid="reply-column"] [aria-label="Close"]',
      ) as HTMLButtonElement
    ).click();
    await tick();
    await vi.waitFor(() => {
      expect(
        host
          .querySelector('[data-testid="chat-stage"]')
          ?.getAttribute("data-reply-open"),
      ).toBe("false");
      expect(host.querySelector("[data-testid=reply-column]")).toBeNull();
    });
  });
});
