// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, tick, unmount } from "svelte";
import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api.js";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";

const now = () => new Date().toISOString();

const seedRow: ChannelDirectoryRow = {
  channelId: "chn_proj",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  name: "launch",
  lastActivityAt: now(),
};

function stubApi(overrides: Partial<ChatSidebarApi> = {}): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [seedRow],
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => ({ channels: [] }),
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    searchMessages: async () => ({ results: [] }),
    ...overrides,
  } as ChatSidebarApi;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.querySelectorAll("[data-testid]").forEach((el) => {
    if (el.closest("body") && !host?.contains(el)) el.remove();
  });
  vi.restoreAllMocks();
});

function q<T extends Element>(sel: string): T | null {
  return (host.querySelector<T>(sel) ?? document.querySelector<T>(sel)) as T | null;
}

async function settle(ms = 0): Promise<void> {
  if (ms) await new Promise((r) => setTimeout(r, ms));
  await Promise.resolve();
  flushSync();
  await tick();
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ChatSidebar unified search", () => {
  // One box, two kinds of answer. Message text used to sit behind a second
  // dialog you had to click into, so you had to know which kind of thing you
  // were looking for before you started looking.
  it("searches conversations and message text from the same query", async () => {
    const searchMessages = vi.fn(async (_args: { q: string }) => ({
      results: [
        {
          messageId: "evt_1",
          scope: "channel" as const,
          channelId: "chn_proj",
          companyUid: "cmp_1",
          body: "the launch checklist is in the doc",
          createdAt: now(),
        },
      ],
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stubApi({ searchMessages }), seedDirectory: [seedRow] },
    });

    await vi.waitFor(() => {
      expect(q('[data-testid="chat-search"]')).toBeTruthy();
    });
    q<HTMLButtonElement>('[data-testid="chat-search"]')!.click();
    await settle();

    const input = q<HTMLInputElement>(".chat-switcher-input")!;
    type(input, "launch");
    await settle();

    // The conversation match is local and immediate.
    expect(
      [...document.querySelectorAll(".chat-switcher-name")].some((el) =>
        el.textContent?.includes("launch"),
      ),
    ).toBe(true);

    // The message match arrives from the server after the debounce, in the
    // SAME list — no second dialog, no extra click.
    await vi.waitFor(
      () => {
        expect(searchMessages).toHaveBeenCalled();
        expect(
          document.querySelector('[data-testid="chat-search-hit"]'),
        ).toBeTruthy();
      },
      { timeout: 3000 },
    );
    expect(searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ q: "launch" }),
    );
    expect(
      document.querySelector('[data-testid="chat-search-hit"]')?.textContent,
    ).toContain("launch checklist");
  });

  it("has no separate message-search dialog left to click into", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stubApi(), seedDirectory: [seedRow] },
    });

    await vi.waitFor(() => {
      expect(q('[data-testid="chat-search"]')).toBeTruthy();
    });
    q<HTMLButtonElement>('[data-testid="chat-search"]')!.click();
    await settle();

    expect(document.querySelector('[data-testid="chat-search-messages"]')).toBeNull();
    expect(document.querySelector('[data-testid="chat-history-view"]')).toBeNull();
  });
});

describe("ChatSidebar search dismissal", () => {
  // Opening a message hit left the dialog sitting over the conversation it
  // had just jumped to.
  it("closes the dialog when a message hit is opened", async () => {
    const searchMessages = vi.fn(async (_args: { q: string }) => ({
      results: [
        {
          messageId: "evt_1",
          scope: "channel" as const,
          channelId: "chn_proj",
          companyUid: "cmp_1",
          body: "the launch checklist is in the doc",
          createdAt: now(),
        },
      ],
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stubApi({ searchMessages }), seedDirectory: [seedRow] },
    });

    await vi.waitFor(() => {
      expect(q('[data-testid="chat-search"]')).toBeTruthy();
    });
    q<HTMLButtonElement>('[data-testid="chat-search"]')!.click();
    await settle();
    type(q<HTMLInputElement>(".chat-switcher-input")!, "launch");

    const hit = await vi.waitFor(
      () => {
        const el = document.querySelector<HTMLButtonElement>(
          '[data-testid="chat-search-hit"]',
        );
        expect(el).toBeTruthy();
        return el!;
      },
      { timeout: 3000 },
    );

    hit.click();
    await settle();

    expect(
      document.querySelector('[data-testid="chat-search-overlay"]'),
    ).toBeNull();
  });
});
