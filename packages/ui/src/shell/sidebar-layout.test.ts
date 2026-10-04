// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { takePendingChannelOpen } from "../chat/open-target";
import { takePendingConversation } from "../chat/pending-conversation";
import type { ChatSidebarApi, NotificationsApi } from "../chat/chat-api";
import type { ConversationRow } from "../chat/sidebar-model";
import { SIDEBAR_OVERLAY_MAX_PX, sidebarLayout } from "./sidebar-layout.js";

describe("sidebarLayout", () => {
  it.each([
    [320, "overlay"],
    [390, "overlay"],
    [SIDEBAR_OVERLAY_MAX_PX, "overlay"],
    [SIDEBAR_OVERLAY_MAX_PX + 1, "column"],
    [1280, "column"],
  ])("resolves %ipx to %s", (width, expected) => {
    expect(sidebarLayout(width)).toBe(expected);
  });
});

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

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let originalMatchMedia: typeof window.matchMedia;

function setWidth(px: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
  window.matchMedia = (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    if (!max) return originalMatchMedia(query);
    const matches = px <= Number(max[1]);
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  };
}

function sidebarApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "c1",
      cursorExpiresAt: "2099-01-01T00:00:00.000Z",
      rows: [],
    }),
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
  const root = {
    eventId: "evt_root",
    body: "root body",
    createdAt: "2026-08-17T01:00:00.000Z",
    fromDisplayName: "Ada",
    replyCount: 0,
  };
  return {
    kind: "web",
    isAvailable: () => false,
    messaging: {
      fetchChannel: async () => ok({ messages: [root], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      fetchReplyThread: async () =>
        ok({ scope: "channel", root, replies: [], replyCount: 0 }),
      sendReply: async () => ok({}),
      sendChannelMessage: async () => ok(undefined),
      sendDm: async () => ok(undefined),
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      toggleReaction: async () => ok(undefined),
    },
  } as unknown as PlatformAdapter;
}

async function mountShell() {
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
}

async function sidebarEl(): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await vi.waitFor(() => {
    found = host.querySelector<HTMLElement>('[data-testid="chat-sidebar"]');
    expect(found).not.toBeNull();
  });
  return found!;
}

beforeEach(() => {
  originalMatchMedia = window.matchMedia.bind(window);
  window.localStorage?.clear?.();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.matchMedia = originalMatchMedia;
  takePendingChannelOpen();
  takePendingConversation();
  window.history.replaceState({}, "", "/");
  window.localStorage?.clear?.();
});

describe("the breakpoint has one value, not two", () => {
  it("starts the channel list closed at the overlay width", async () => {
    setWidth(SIDEBAR_OVERLAY_MAX_PX);
    await mountShell();
    const sidebar = await sidebarEl();
    expect(sidebar.classList.contains("offscreen")).toBe(true);
  });

  it("starts the channel list as a column once the window is wider", async () => {
    setWidth(SIDEBAR_OVERLAY_MAX_PX + 1);
    await mountShell();
    const sidebar = await sidebarEl();
    expect(sidebar.classList.contains("offscreen")).toBe(false);
  });

  it("uses that same width for the overlay stylesheet and the shell anchor", async () => {
    setWidth(1280);
    await mountShell();
    await tick();
    const styles = [...document.querySelectorAll("style")].map(
      (node) => node.textContent ?? "",
    );
    const query = `@media (max-width: ${SIDEBAR_OVERLAY_MAX_PX}px)`;
    const chat = styles.find((css) => css.includes("chat-sidebar"));
    const shell = styles.find((css) => css.includes("desktop-body"));
    expect(chat, "chat sidebar stylesheet").toBeDefined();
    expect(shell, "shell stylesheet").toBeDefined();
    expect(chat).toContain(query);
    const at = shell!.indexOf(query);
    expect(at, "shell has no narrow-viewport block").toBeGreaterThan(-1);
    const slice = shell!.slice(at, at + 600);
    expect(slice).toContain("desktop-body");
    expect(slice).toContain("position: relative");
  });
});
