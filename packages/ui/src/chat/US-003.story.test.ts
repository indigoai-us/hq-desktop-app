// @vitest-environment happy-dom

/**
 * US-003 story acceptance: Reply affordance + ReplyPanel.
 *
 * Product copy: “replies” / “Reply”. Chrome says “Thread”.
 * Not a work-mesh thread and not GET /v1/notify/thread.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ConversationView from "./ConversationView.svelte";
import ChannelConversation from "./messaging/ChannelConversation.svelte";
import ReplyPanel from "./messaging/ReplyPanel.svelte";
import type {
  ConversationApi,
  ConversationMessageWire,
  ReplyThreadResponse,
} from "./chat-api";
import type { ConversationRow } from "./sidebar-model";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const projectRow: ConversationRow = {
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

const chatRow: ConversationRow = {
  id: "ch:chn_chat",
  kind: "channel",
  title: "general",
  companyUid: "cmp_acme",
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  channelId: "chn_chat",
};

const dmRow: ConversationRow = {
  id: "dm:prs_ada",
  kind: "dm",
  title: "Ada",
  companyUid: null,
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  personUid: "prs_ada",
};

const root: ConversationMessageWire = {
  eventId: "evt_root",
  body: "root body",
  createdAt: "2026-08-17T01:00:00.000Z",
  fromDisplayName: "Ada",
  replyCount: 0,
};

const dmRoot: ConversationMessageWire = {
  eventId: "evt_dm_root",
  body: "dm root",
  createdAt: "2026-08-17T01:00:00.000Z",
  fromDisplayName: "Ada",
  replyCount: 1,
};

const existingReply: ConversationMessageWire = {
  eventId: "evt_existing",
  rootEventId: "evt_dm_root",
  body: "already here",
  createdAt: "2026-08-17T01:05:00.000Z",
  fromDisplayName: "Bea",
};

function conversationApi(options: {
  messages?: ConversationMessageWire[];
  thread?: ReplyThreadResponse;
  sendReply?: (body: string) => Promise<void>;
}): ConversationApi & { sendCalls: string[]; fetchCalls: number } {
  const sendCalls: string[] = [];
  let fetchCalls = 0;
  const api: ConversationApi & { sendCalls: string[]; fetchCalls: number } = {
    sendCalls,
    get fetchCalls() {
      return fetchCalls;
    },
    fetchChannel: async () => ({
      messages: options.messages ?? [root],
      nextCursor: null,
    }),
    sendChannelMessage: async () => {},
    fetchDmThread: async () => ({
      messages: options.messages ?? [dmRoot],
      nextCursor: null,
    }),
    sendDm: async () => {},
    fetchReplyThread: async () => {
      fetchCalls += 1;
      return (
        options.thread ?? {
          scope: "channel",
          root: options.messages?.[0] ?? root,
          replies: [],
          replyCount: 0,
        }
      );
    },
    sendReply: async (args) => {
      sendCalls.push(args.body);
      if (options.sendReply) await options.sendReply(args.body);
    },
  };
  return api;
}

describe("US-003: Reply affordance + ReplyPanel in the shared shell", () => {
  it("opens ReplyPanel from Reply, closes via Close and Esc", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const api = conversationApi({ messages: [root] });
    component = mount(ConversationView, {
      target: host,
      props: { api, row: projectRow },
    });
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-event-id="evt_root"]')).not.toBeNull();
    });

    const replyBtn = host.querySelector(
      '[data-testid="message-reply"]',
    ) as HTMLButtonElement;
    expect(replyBtn).not.toBeNull();
    expect(replyBtn.textContent?.trim()).toBe("Reply");
    replyBtn.click();
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="reply-panel"]')).not.toBeNull();
    });
    expect(
      host.querySelector('[data-testid="reply-panel-title"]')?.textContent,
    ).toBe("Thread");

    (
      host.querySelector(
        '[data-testid="reply-panel-close"]',
      ) as HTMLButtonElement
    ).click();
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="reply-panel"]')).toBeNull();
    });

    replyBtn.click();
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="reply-panel"]')).not.toBeNull();
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="reply-panel"]')).toBeNull();
    });
  });

  it("shows empty replies and does not require lastReplyAt from the list API", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        messages: [{ ...root, replyCount: 0 }],
      },
    });
    await tick();
    expect(host.querySelector('[data-testid="message-replies"]')).toBeNull();
    expect(host.textContent).not.toMatch(/ago/);

    host.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    const api = conversationApi({
      messages: [root],
      thread: {
        scope: "channel",
        root,
        replies: [],
        replyCount: 0,
      },
    });
    component = mount(ReplyPanel, {
      target: host,
      props: {
        api,
        rootEventId: "evt_root",
        scope: "channel",
        channelId: "chn_proj",
        seedRoot: root,
        onclose: () => {},
      },
    });
    await tick();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="reply-panel-empty"]'),
      ).not.toBeNull();
    });
    expect(host.textContent).toContain("No replies yet");
  });

  it("retries a failed send without re-GETting the reply thread", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    let failOnce = true;
    const api = conversationApi({
      messages: [root],
      sendReply: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("network");
        }
      },
    });
    component = mount(ReplyPanel, {
      target: host,
      props: {
        api,
        rootEventId: "evt_root",
        scope: "channel",
        channelId: "chn_proj",
        seedRoot: root,
        onclose: () => {},
      },
    });
    await tick();
    await vi.waitFor(() => expect(api.fetchCalls).toBe(1));

    const composer = host.querySelector(
      '[data-testid="reply-panel-composer"]',
    ) as HTMLTextAreaElement;
    composer.value = "ok";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (
      host.querySelector(
        '[data-testid="reply-panel-send"]',
      ) as HTMLButtonElement
    ).click();
    await tick();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="reply-panel-retry"]'),
      ).not.toBeNull();
    });
    expect(api.fetchCalls).toBe(1);

    (
      host.querySelector(
        '[data-testid="reply-panel-retry"]',
      ) as HTMLButtonElement
    ).click();
    await tick();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="reply-panel-retry"]'),
      ).toBeNull();
      expect(host.textContent).toContain("ok");
    });
    expect(api.sendCalls).toEqual(["ok", "ok"]);
    expect(api.fetchCalls).toBe(1);
  });

  it("Given a project channel root with 0 replies, when the user clicks Reply and sends “ok”, then the panel shows that reply and the main timeline still has only the root", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const api = conversationApi({ messages: [root] });
    component = mount(ConversationView, {
      target: host,
      props: { api, row: projectRow },
    });
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-event-id="evt_root"]')).not.toBeNull();
    });
    (
      host.querySelector('[data-testid="message-reply"]') as HTMLButtonElement
    ).click();
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="reply-panel"]')).not.toBeNull();
    });
    const composer = host.querySelector(
      '[data-testid="reply-panel-composer"]',
    ) as HTMLTextAreaElement;
    composer.value = "ok";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (
      host.querySelector(
        '[data-testid="reply-panel-send"]',
      ) as HTMLButtonElement
    ).click();
    await tick();
    await vi.waitFor(() => {
      const panelMsgs = host.querySelectorAll(
        '[data-testid="reply-panel-message"]',
      );
      expect(panelMsgs.length).toBeGreaterThan(0);
    });
    expect(
      host.querySelector('[data-testid="reply-panel"]')?.textContent,
    ).toContain("ok");
    const timeline = host.querySelector('[data-testid="conversation-thread"]');
    expect(
      timeline?.querySelectorAll('[data-testid="conversation-message"]'),
    ).toHaveLength(1);
    expect(timeline?.textContent).toContain("root body");
    expect(
      timeline?.querySelector('[data-testid="reply-panel-message"]'),
    ).toBeNull();
  });

  it("Given a DM root with replyCount 1, when the user taps “1 reply”, then the panel loads the root plus that reply", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const api = conversationApi({
      messages: [dmRoot],
      thread: {
        scope: "dm",
        root: dmRoot,
        replies: [existingReply],
        replyCount: 1,
      },
    });
    component = mount(ConversationView, {
      target: host,
      props: { api, row: dmRow },
    });
    await tick();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="message-replies"]')?.textContent,
      ).toContain("1 reply");
    });
    (
      host.querySelector('[data-testid="message-replies"]') as HTMLButtonElement
    ).click();
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="reply-panel"]')).not.toBeNull();
      expect(
        host.querySelector('[data-testid="reply-panel-root"]')?.textContent,
      ).toContain("dm root");
      expect(
        host.querySelector('[data-testid="reply-panel-message"]')?.textContent,
      ).toContain("already here");
    });
  });

  it("Given a chat channel at a narrow viewport, when the panel opens, then it overlays the timeline and Close returns to the timeline", async () => {
    window.matchMedia = (query: string) =>
      ({
        matches: String(query).includes("720"),
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
          return false;
        },
        onchange: null,
      }) as MediaQueryList;

    host = document.createElement("div");
    document.body.appendChild(host);
    const api = conversationApi({ messages: [root] });
    component = mount(ConversationView, {
      target: host,
      props: { api, row: chatRow },
    });
    await tick();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="message-reply"]'),
      ).not.toBeNull();
    });
    (
      host.querySelector('[data-testid="message-reply"]') as HTMLButtonElement
    ).click();
    await tick();
    await vi.waitFor(() => {
      const column = host.querySelector('[data-testid="reply-column"]');
      expect(column).not.toBeNull();
      expect(column?.getAttribute("data-reply-layout")).toBe("overlay");
    });
    expect(
      host.querySelector('[data-testid="conversation-thread"]'),
    ).not.toBeNull();
    (
      host.querySelector(
        '[data-testid="reply-panel-close"]',
      ) as HTMLButtonElement
    ).click();
    await tick();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="reply-panel"]')).toBeNull();
      expect(
        host.querySelector('[data-testid="conversation-thread"]'),
      ).not.toBeNull();
    });
  });
});
