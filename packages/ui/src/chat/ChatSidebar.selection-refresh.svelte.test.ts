// @vitest-environment happy-dom

/**
 * Selection is keyed by the stable conversation id (`ch:…` / `dm:…`), not by
 * a row's position, so a directory refresh that reorders the rail or adds a
 * row keeps the same conversations selected and their boxes ticked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function seedRow(id: string, name: string, minutesAgo: number): ChannelDirectoryRow {
  return {
    channelId: id,
    type: "project",
    scope: "project",
    companyUid: "cmp_1",
    name,
    lastActivityAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  };
}

let directory: ChannelDirectoryRow[] = [];

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: directory,
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
  };
}

function boxFor(id: string): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(`[data-checkbox-for="${id}"]`);
  if (!el) throw new Error(`no checkbox for ${id}`);
  return el;
}

/** Same browser-ordered click as ChatSidebar.selection-checkbox.test.ts. */
function realClick(el: HTMLElement): void {
  const flush = () => flushSync();
  document.addEventListener("click", flush);
  try {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  } finally {
    document.removeEventListener("click", flush);
  }
}

function paintedIds(): string[] {
  return [...host.querySelectorAll<HTMLElement>(".chat-row[data-conversation-id]")]
    .map((el) => el.dataset.conversationId!)
    .filter((id) => id.startsWith("ch:chn_"));
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
});

describe("ChatSidebar selection across a list refresh", () => {
  it("keeps the same conversations selected when a refresh reorders the rail", async () => {
    directory = [
      seedRow("chn_a", "alpha", 1),
      seedRow("chn_b", "bravo", 2),
      seedRow("chn_c", "charlie", 3),
    ];
    const props = $state({ api: stubApi(), seedDirectory: directory });
    component = mount(ChatSidebar, { target: host, props });
    await vi.waitFor(() => expect(paintedIds()).toEqual(["ch:chn_a", "ch:chn_b", "ch:chn_c"]));

    realClick(boxFor("ch:chn_a"));
    realClick(boxFor("ch:chn_c"));
    await tick();
    expect(boxFor("ch:chn_a").checked).toBe(true);
    expect(boxFor("ch:chn_c").checked).toBe(true);

    // charlie gets a new message and a new row arrives: the order changes.
    directory = [
      seedRow("chn_c", "charlie", 0),
      seedRow("chn_d", "delta", 0.5),
      seedRow("chn_a", "alpha", 1),
      seedRow("chn_b", "bravo", 2),
    ];
    props.seedDirectory = directory;
    await vi.waitFor(() =>
      expect(paintedIds()).toEqual(["ch:chn_c", "ch:chn_d", "ch:chn_a", "ch:chn_b"]),
    );
    await tick();

    expect(boxFor("ch:chn_c").checked).toBe(true);
    expect(boxFor("ch:chn_a").checked).toBe(true);
    expect(boxFor("ch:chn_b").checked).toBe(false);
    expect(boxFor("ch:chn_d").checked).toBe(false);
    expect(
      document.querySelector('[data-testid="chat-selection-count"]')?.textContent,
    ).toContain("2 selected");
  });
});
