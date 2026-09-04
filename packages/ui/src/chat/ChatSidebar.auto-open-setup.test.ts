// @vitest-environment happy-dom

/**
 * Non-cohort / empty-tenant boot: the synthetic #setup row is the only
 * conversation. Before the fix, auto-open skipped it forever and the
 * conversation pane stayed on ChannelSkeleton. A 404 or hung directory
 * fetch must still select #setup within the boot timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import { SETUP_ROW_ID } from "./setup-channel";
import { tenantStorageKey } from "../identity/tenant-storage.js";
import { CONVERSATION_CACHE_KEY } from "./sidebar-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const liveRow: ChannelDirectoryRow = {
  channelId: "chn_proj",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  name: "launch",
  lastActivityAt: new Date().toISOString(),
};

function emptyFeed() {
  return {
    snapshot: true,
    cursor: "cur_empty",
    cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    rows: [] as ChannelDirectoryRow[],
  };
}

function stubApi(overrides: Partial<ChatSidebarApi> = {}): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => emptyFeed(),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
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
});

describe("ChatSidebar auto-opens #setup after a failed/empty first paint", () => {
  it("auto-selects #setup when the directory 404s and there are no other rows", async () => {
    const onselect = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({
          fetchChannelDirectory: async () => {
            throw new Error("[http-404] GET /v1/notify/channels failed");
          },
        }),
        onselect,
        bootTimeoutMs: 40,
      },
    });
    await vi.waitFor(() => {
      expect(onselect).toHaveBeenCalled();
    });
    expect(onselect.mock.calls[0]?.[0]?.id).toBe(SETUP_ROW_ID);
    expect(host.querySelector('[data-testid="chat-load-error"]')?.textContent).toMatch(
      /Couldn’t load conversations/,
    );
  });

  it("auto-selects #setup when the directory hangs past the boot timeout", async () => {
    const onselect = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({
          fetchChannelDirectory: () => new Promise(() => {}),
        }),
        onselect,
        bootTimeoutMs: 40,
      },
    });
    expect(onselect).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(onselect).toHaveBeenCalled();
    });
    expect(onselect.mock.calls[0]?.[0]?.id).toBe(SETUP_ROW_ID);
  });

  it("still auto-opens a real channel immediately, without waiting on #setup", async () => {
    const onselect = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({
          fetchChannelDirectory: async () => ({
            snapshot: true,
            cursor: "cur_1",
            cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            rows: [liveRow],
          }),
        }),
        seedDirectory: [liveRow],
        onselect,
        bootTimeoutMs: 5_000,
      },
    });
    await vi.waitFor(() => {
      expect(onselect).toHaveBeenCalled();
    });
    expect(onselect.mock.calls[0]?.[0]?.id).toBe("ch:chn_proj");
  });

  it("an upgraded install with a malformed conversation cache still opens #setup", async () => {
    const onselect = vi.fn();
    window.localStorage.setItem(
      tenantStorageKey(
        { accountId: "acct_ga", companyId: "all" },
        CONVERSATION_CACHE_KEY,
      ),
      "{not-json",
    );
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({
          fetchChannelDirectory: async () => {
            throw new Error("[http-404] GET /v1/notify/channels failed");
          },
        }),
        tenantAccountId: "acct_ga",
        tenantCompanyId: "all",
        onselect,
        bootTimeoutMs: 40,
      },
    });
    await vi.waitFor(() => {
      expect(onselect).toHaveBeenCalled();
    });
    expect(onselect.mock.calls[0]?.[0]?.id).toBe(SETUP_ROW_ID);
  });
});
