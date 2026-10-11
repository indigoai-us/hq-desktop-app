// @vitest-environment happy-dom

/**
 * Chat-stage reply-column layout: data-reply-open + column (wide viewport).
 *
 * happy-dom default width is wide, so the pane is a sibling column rather
 * than the narrow overlay. Assertions stay on classes/attributes — not
 * computed styles.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    logToFile: async () => {},
    ensureCompanyHomeChannel: async (companyUid: string) => ({ homeChannelId: `chn_home_${companyUid}` }),
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
  messages?: unknown[];
}): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    messaging: {
      fetchChannel: async () =>
        ok({
          messages: options.messages ?? [root],
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
  it("resizes with the keyboard and pointer while preserving room for messages", async () => {
    await mountShell({ initialReplyRootEventId: "evt_root" });
    await vi.waitFor(() =>
      expect(host.querySelector('[aria-label="Resize thread panel"]')).not.toBeNull(),
    );
    const handle = host.querySelector(
      '[aria-label="Resize thread panel"]',
    ) as HTMLElement;
    const column = handle.parentElement!;
    const stage = column.parentElement!;
    // US-015 (home-thread): the thread pane opens at 360 px until resized.
    expect(column.style.getPropertyValue("--thread-width")).toBe("360px");
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      width: 1000,
    } as DOMRect);
    vi.spyOn(column, "getBoundingClientRect").mockReturnValue({
      width: 500,
    } as DOMRect);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await tick();
    expect(column.style.getPropertyValue("--thread-width")).toBe("520px");
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = () => true;
    handle.releasePointerCapture = vi.fn();
    handle.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 500, pointerId: 1, bubbles: true }),
    );
    handle.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 0, pointerId: 1, bubbles: true }),
    );
    await tick();
    expect(column.style.getPropertyValue("--thread-width")).toBe("640px");
    handle.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 1000, pointerId: 1, bubbles: true }),
    );
    await tick();
    expect(column.style.getPropertyValue("--thread-width")).toBe("280px");
    handle.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }));
    handle.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 0, pointerId: 1, bubbles: true }),
    );
    await tick();
    expect(column.style.getPropertyValue("--thread-width")).toBe("280px");
  });

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

  it("closes the thread when the open thread's own replies pill is clicked", async () => {
    await mountShell({ initialReplyRootEventId: null });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="message-replies"]')).not.toBeNull(),
    );
    const pill = () =>
      host.querySelector('[data-testid="message-replies"]') as HTMLButtonElement;

    pill().click();
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector("[data-testid=reply-column]")).not.toBeNull();
      expect(pill().getAttribute("aria-expanded")).toBe("true");
    });

    // Same pill again: a toggle, through the pane's own close path.
    pill().click();
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector("[data-testid=reply-column]")).toBeNull();
      expect(
        host
          .querySelector('[data-testid="chat-stage"]')
          ?.getAttribute("data-reply-open"),
      ).toBe("false");
    });
    expect(pill().getAttribute("aria-expanded")).toBe("false");
  });

  it("paints no second ground under the thread and keeps one divider", async () => {
    await mountShell({ initialReplyRootEventId: "evt_root" });
    await vi.waitFor(() =>
      expect(host.querySelector("[data-testid=reply-column]")).not.toBeNull(),
    );
    const column = host.querySelector("[data-testid=reply-column]")!;
    expect(column.classList.contains("thread-column")).toBe(true);

    const style = (
      readFileSync(resolve("src/shell/DesktopApp.svelte"), "utf8").split(
        "<style>",
      )[1] ?? ""
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return style.match(new RegExp(`\\n  ${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    };
    // Side by side the shell root's ground plus ReplyPanel's --side-bg is the
    // whole stack; the narrow overlay keeps an opaque fill of its own.
    expect(rule(".reply-column.thread-column:not(.overlay)")).toMatch(
      /background:\s*none/,
    );
    expect(rule(".reply-column.overlay")).toMatch(/background:/);
    // The column owns the divider (ReplyPanel no longer draws its own).
    expect(rule(".reply-column")).toMatch(/border-left:\s*1px solid var\(--line\)/);
  });

  it("toggles the second thread shut instead of walking back into the first", async () => {
    const second = {
      eventId: "evt_root_2",
      body: "second root",
      createdAt: "2026-08-17T01:05:00.000Z",
      fromDisplayName: "Bob",
      replyCount: 1,
    };
    await mountShell(
      { initialReplyRootEventId: null },
      { messages: [root, second] },
    );
    const pill = (id: string) =>
      host.querySelector(
        `[data-event-id="${id}"] [data-testid="message-replies"]`,
      ) as HTMLButtonElement;
    await vi.waitFor(() => expect(pill("evt_root_2")).not.toBeNull());

    pill("evt_root").click();
    await tick();
    await vi.waitFor(() =>
      expect(pill("evt_root").getAttribute("aria-expanded")).toBe("true"),
    );
    pill("evt_root_2").click();
    await tick();
    await vi.waitFor(() =>
      expect(pill("evt_root_2").getAttribute("aria-expanded")).toBe("true"),
    );

    pill("evt_root_2").click();
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector("[data-testid=reply-column]")).toBeNull();
    });
    expect(pill("evt_root").getAttribute("aria-expanded")).toBe("false");
    expect(pill("evt_root_2").getAttribute("aria-expanded")).toBe("false");
  });
});
