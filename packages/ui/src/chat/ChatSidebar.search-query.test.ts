// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import { type ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import { buildAgentHelloRequest } from "./agent-channel";

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

describe("ChatSidebar message search and the app's requests to a bot (review B-3)", () => {
  it("does not show the request the app wrote to a bot, and shows the bot's and the person's own messages", async () => {
    const request = buildAgentHelloRequest({ personName: "Ada", filesStillDownloading: false, companyApps: "" });
    const searchMessages = vi.fn<ChatSidebarApi["searchMessages"]>(async () => ({
      results: [
        // What the desktop search command returns: no sender, no direction.
        { messageId: "evt_request", scope: "dm", counterpartyUid: "agt_nova", body: request, createdAt: "2026-10-02T10:00:00.000Z" },
        { messageId: "evt_hello", scope: "dm", counterpartyUid: "agt_nova", body: "Hello Ada, your setup is done.", createdAt: "2026-10-02T10:00:05.000Z" },
        { messageId: "evt_mine", scope: "dm", counterpartyUid: "agt_nova", body: "Is my setup finished?", createdAt: "2026-10-02T10:01:00.000Z" },
        // Another person quoting the same words in a channel is their message.
        { messageId: "evt_quote", scope: "channel", channelId: "chn_search", body: request, createdAt: "2026-10-02T10:02:00.000Z" },
      ],
    }));
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({ searchMessages }),
        seedDirectory: [seedRow],
        self: { uid: "prs_ada", displayName: "Ada" },
      },
    });

    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="chat-show-history"]')).toBeTruthy(),
    );
    host.querySelector<HTMLButtonElement>('[data-testid="chat-show-history"]')!.click();
    await tick();
    const input = host.querySelector<HTMLInputElement>('[data-testid="chat-history-search"]')!;
    input.value = "setup";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(searchMessages).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(host.querySelectorAll('[data-testid="chat-search-hit"]').length).toBeGreaterThan(0),
    );

    const shown = [...host.querySelectorAll('[data-testid="chat-search-hit"]')].map(
      (node) => node.textContent?.replace(/\s+/g, " ").trim() ?? "",
    );
    expect(shown).toHaveLength(3);
    expect(shown.filter((line) => line.includes("Automatic message from HQ"))).toHaveLength(1);
    expect(shown.some((line) => line.includes("Hello Ada, your setup is done."))).toBe(true);
    expect(shown.some((line) => line.includes("Is my setup finished?"))).toBe(true);
    // The one that is left is the channel message, not the request in the bot's direct message.
    expect(shown.find((line) => line.includes("Automatic message from HQ"))).toContain("Search test");
  });

  it("says there are no matches when the only match is the app's own request", async () => {
    const request = buildAgentHelloRequest({ personName: "Ada", filesStillDownloading: false, companyApps: "" });
    const searchMessages = vi.fn<ChatSidebarApi["searchMessages"]>(async () => ({
      results: [
        { messageId: "evt_request", scope: "dm", counterpartyUid: "agt_nova", body: request, createdAt: "2026-10-02T10:00:00.000Z" },
      ],
    }));
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stubApi({ searchMessages }), seedDirectory: [seedRow], self: { uid: "prs_ada" } },
    });

    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="chat-show-history"]')).toBeTruthy(),
    );
    host.querySelector<HTMLButtonElement>('[data-testid="chat-show-history"]')!.click();
    await tick();
    const input = host.querySelector<HTMLInputElement>('[data-testid="chat-history-search"]')!;
    input.value = "Automatic message";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(searchMessages).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="chat-history-results"]')?.textContent).toContain("No matching messages"),
    );

    expect(host.querySelector('[data-testid="chat-search-hit"]')).toBeNull();
  });
});
