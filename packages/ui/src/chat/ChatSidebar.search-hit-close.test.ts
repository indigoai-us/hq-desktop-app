// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import { type ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const seedRow: ChannelDirectoryRow = {
  channelId: "chn_search",
  type: "project",
  scope: "project",
  companyUid: "cmp_search",
  name: "Search test",
  lastActivityAt: new Date().toISOString(),
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
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
    logToFile: async () => {},
    ensureCompanyHomeChannel: async (companyUid: string) => ({
      homeChannelId: `chn_home_${companyUid}`,
    }),
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage?.clear?.();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage?.clear?.();
  vi.restoreAllMocks();
});

describe("ChatSidebar history dialog dismissal", () => {
  // Opening a message hit jumped to the message and left the history dialog
  // sitting on top of it.
  it("closes the history dialog when a message hit is opened", async () => {
    const searchMessages = vi.fn<ChatSidebarApi["searchMessages"]>(async () => ({
      results: [
        {
          messageId: "evt_launch",
          scope: "channel",
          channelId: "chn_search",
          companyUid: "cmp_search",
          body: "the launch checklist is in the doc",
          createdAt: "2026-10-02T10:00:00.000Z",
        },
      ],
    }));
    const onselect = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stubApi({ searchMessages }), seedDirectory: [seedRow], onselect },
    });

    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="chat-show-history"]')).toBeTruthy(),
    );
    host.querySelector<HTMLButtonElement>('[data-testid="chat-show-history"]')!.click();
    await tick();
    expect(document.querySelector('[data-testid="chat-history-view"]')).toBeTruthy();

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="chat-history-search"]',
    )!;
    input.value = "launch";
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
    await tick();

    // The hit still opens its conversation...
    expect(onselect).toHaveBeenCalled();
    expect(onselect.mock.calls.at(-1)?.[0]).toMatchObject({ channelId: "chn_search" });
    // ...and the dialog is gone rather than covering it.
    expect(document.querySelector('[data-testid="chat-history-view"]')).toBeNull();

    // Reopening starts from an empty query, not the stale hit list.
    host.querySelector<HTMLButtonElement>('[data-testid="chat-show-history"]')!.click();
    await tick();
    expect(document.querySelector('[data-testid="chat-history-view"]')).toBeTruthy();
    expect(
      document.querySelector<HTMLInputElement>('[data-testid="chat-history-search"]')!.value,
    ).toBe("");
    expect(document.querySelector('[data-testid="chat-search-hit"]')).toBeNull();
  });

  // With an empty query the dialog lists recent conversations. Opening one of
  // those (click, or Enter/Space on the focused row) also left the dialog
  // sitting on top of the conversation it had just opened.
  it("closes the history dialog when a recent conversation row is opened", async () => {
    const onselect = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stubApi(), seedDirectory: [seedRow], onselect },
    });

    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="chat-show-history"]')).toBeTruthy(),
    );
    host.querySelector<HTMLButtonElement>('[data-testid="chat-show-history"]')!.click();
    await tick();
    expect(document.querySelector('[data-testid="chat-history-view"]')).toBeTruthy();
    expect(
      document.querySelector<HTMLInputElement>('[data-testid="chat-history-search"]')!.value,
    ).toBe("");

    const row = await vi.waitFor(() => {
      const el = [
        ...document.querySelectorAll<HTMLButtonElement>('[data-testid="chat-history-row"]'),
      ].find((b) => b.textContent?.includes("Search test"));
      expect(el).toBeTruthy();
      return el!;
    });
    // A native button: Enter and Space activate it through the same click
    // handler, so the keyboard path closes the dialog too.
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("type")).toBe("button");

    onselect.mockClear();
    row.focus();
    row.click();
    await tick();

    expect(onselect).toHaveBeenCalled();
    expect(onselect.mock.calls.at(-1)?.[0]).toMatchObject({ channelId: "chn_search" });
    expect(document.querySelector('[data-testid="chat-history-view"]')).toBeNull();
  });
});
