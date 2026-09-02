// @vitest-environment happy-dom

/**
 * Rows with an unsent composer draft show a small pencil "Draft" marker
 * (Slack pattern). The rail reads the tenant-scoped draft blob and refreshes
 * on the `hq:composer-draft-changed` window event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import { createTenantStorage } from "../identity/tenant-storage";
import { clearDraft, saveDraft } from "./messaging/composer-drafts";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const rows: ChannelDirectoryRow[] = [
  {
    channelId: "chn_a",
    type: "project",
    scope: "project",
    companyUid: "cmp_1",
    name: "alpha",
    lastActivityAt: new Date().toISOString(),
  },
  {
    channelId: "chn_b",
    type: "project",
    scope: "project",
    companyUid: "cmp_1",
    name: "beta",
    lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
  },
];

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows,
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
  };
}

const tenantStorage = () =>
  createTenantStorage(window.localStorage, {
    accountId: "acct_test",
    companyId: "all",
  });

function draftMarkerFor(rowId: string): Element | null {
  return (
    host
      .querySelector(`[data-conversation-id="${rowId}"]`)
      ?.querySelector('[data-testid="chat-row-draft"]') ?? null
  );
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

describe("ChatSidebar draft markers", () => {
  it("shows the pencil on rows with a stored draft and drops it on the clear event", async () => {
    const storage = tenantStorage();
    saveDraft(storage, "ch:chn_a", "unsent words");

    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: rows,
        tenantAccountId: "acct_test",
        tenantCompanyId: "all",
      },
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-conversation-id="ch:chn_b"]')).toBeTruthy();
    });

    const marker = draftMarkerFor("ch:chn_a");
    expect(marker).toBeTruthy();
    expect(marker?.getAttribute("aria-label")).toBe("Draft");
    expect(marker?.getAttribute("title")).toBe("Draft");
    expect(draftMarkerFor("ch:chn_b")).toBeNull();

    // A draft appears elsewhere → marker follows the event.
    saveDraft(storage, "ch:chn_b", "another");
    await tick();
    expect(draftMarkerFor("ch:chn_b")).toBeTruthy();

    // Sending clears the draft → marker disappears.
    clearDraft(storage, "ch:chn_a");
    await tick();
    expect(draftMarkerFor("ch:chn_a")).toBeNull();
    expect(draftMarkerFor("ch:chn_b")).toBeTruthy();
  });

  it("keeps the unread badge intact next to the marker", async () => {
    const storage = tenantStorage();
    // Draft + unread on the row that is NOT auto-opened (opening marks read).
    saveDraft(storage, "ch:chn_b", "unsent words");
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: [rows[0], { ...rows[1], unreadCount: 3 }],
        tenantAccountId: "acct_test",
        tenantCompanyId: "all",
      },
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-conversation-id="ch:chn_b"]')).toBeTruthy();
    });
    const row = host.querySelector('[data-conversation-id="ch:chn_b"]')!;
    expect(row.querySelector('[data-testid="chat-row-draft"]')).toBeTruthy();
    expect(
      row.querySelector('[data-testid="chat-unread-badge"]')?.textContent?.trim(),
    ).toBe("3");
  });
});
