// @vitest-environment happy-dom

/**
 * US-005 story acceptance: deep-link a reply thread from a URL.
 *
 * Query key is `reply=` — never `thread=` (work-mesh collision).
 * Missing / unauthorized roots leave the panel closed with no enumeration.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "../shell/DesktopApp.svelte";
import {
  parseConversationDeepLink,
  requestChannelOpen,
  takePendingChannelOpen,
} from "./open-target";
import {
  requestConversation,
  takePendingConversation,
} from "./pending-conversation";
import type { ChatSidebarApi, NotificationsApi } from "./chat-api";
import type { ConversationRow } from "./sidebar-model";

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

describe("US-005: Deep-link a reply thread from a URL", () => {
  it("honors ?reply= (not ?thread=) and opens Chat + ReplyPanel for that root", async () => {
    expect(
      parseConversationDeepLink("?thread=evt_root").replyRootEventId,
    ).toBeNull();
    expect(
      parseConversationDeepLink("?channel=chn_proj&reply=evt_root"),
    ).toEqual({
      channelId: "chn_proj",
      personUid: null,
      replyRootEventId: "evt_root",
    });

    await mountShell({ initialReplyRootEventId: "evt_root" });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="channel-name"]')?.textContent,
      ).toBe("launch");
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="reply-panel"]')).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="reply-column"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="reply-panel-title"]')?.textContent,
    ).toBe("Thread");
  });

  it("reads ?channel=&reply= from the location search on mount (desktop deep-link)", async () => {
    window.history.replaceState({}, "", "/?channel=chn_proj&reply=evt_root");
    await mountShell({ initialRow: null, initialReplyRootEventId: null });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="channel-name"]')?.textContent,
      ).toBe("launch");
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="reply-panel"]')).not.toBeNull();
    });
  });

  it("leaves the panel closed for a missing/unauthorized root and leaks no personUid", async () => {
    await mountShell(
      { initialReplyRootEventId: "evt_secret" },
      {
        threadError: {
          code: "THREAD_NOT_FOUND",
          message: "THREAD_NOT_FOUND personUid=prs_secret",
        },
      },
    );
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="channel-name"]')?.textContent,
      ).toBe("launch");
    });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.querySelector('[data-testid="reply-panel"]')).toBeNull();
    expect(host.textContent).not.toContain("prs_secret");
    expect(host.textContent).not.toContain("THREAD_NOT_FOUND");
    expect(host.textContent).not.toContain("evt_secret");
  });

  it.skip("open-target / pending-conversation can carry replyRootEventId", async () => {
    await mountShell({ initialReplyRootEventId: null });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="channel-name"]')).not.toBeNull();
    });
    requestChannelOpen("chn_proj", { replyRootEventId: "evt_root" });
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="reply-panel"]')).not.toBeNull();
    });

    requestConversation({
      personUid: "prs_ada",
      email: "ada@example.com",
      displayName: "Ada",
      replyRootEventId: "evt_dm_root",
    });
    expect(takePendingConversation()?.replyRootEventId).toBe("evt_dm_root");
  });
});
