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

describe("ChatSidebar message search query length", () => {
  it("skips queries outside 2..=100 while sending a two-character query", async () => {
    const searchMessages = vi.fn<ChatSidebarApi["searchMessages"]>(async () => ({
      results: [],
    }));
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stubApi({ searchMessages }), seedDirectory: [seedRow] },
    });

    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="chat-show-history"]')).toBeTruthy(),
    );
    host.querySelector<HTMLButtonElement>('[data-testid="chat-show-history"]')!.click();
    await tick();
    const input = host.querySelector<HTMLInputElement>(
      '[data-testid="chat-history-search"]',
    )!;

    const enterQuery = async (query: string) => {
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 260));
      await tick();
    };

    await enterQuery("a");
    expect(searchMessages).not.toHaveBeenCalled();
    expect(
      host.querySelector('[data-testid="chat-history-results"] [role="status"]')
        ?.textContent,
    ).toContain("Type at least 2 characters");
    expect(host.querySelector('[data-testid="chat-history-results"] [role="alert"]'))
      .toBeNull();

    await enterQuery("ab");
    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(searchMessages.mock.calls[0]?.[0]).toMatchObject({ q: "ab" });

    await enterQuery("x".repeat(101));
    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(
      host.querySelector('[data-testid="chat-history-results"] [role="status"]')
        ?.textContent,
    ).toContain("Search is limited to 100 characters");
    expect(host.querySelector('[data-testid="chat-history-results"] [role="alert"]'))
      .toBeNull();
  });
});
