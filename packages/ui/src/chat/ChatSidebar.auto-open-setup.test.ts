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
import { createChatWakeBus } from "./chat-api";
import type { Workspace } from "./workspaces";
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

const ACME: Workspace = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "cloud-only",
  cloudUid: "cmp_acme",
  bucketName: null,
  hasLocalFolder: false,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
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

describe("ChatSidebar boot before setup has run on this machine", () => {
  it("lands on #welcome even though a live company channel exists", async () => {
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
        companies: [ACME],
        welcomeFirst: true,
        onselect,
        bootTimeoutMs: 5_000,
      },
    });
    await vi.waitFor(() => {
      expect(onselect).toHaveBeenCalled();
    });
    expect(onselect.mock.calls[0]?.[0]?.id).toBe(SETUP_ROW_ID);
  });

  it("opens the live channel as before once setup has run", async () => {
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
        companies: [ACME],
        welcomeFirst: false,
        onselect,
        bootTimeoutMs: 5_000,
      },
    });
    await vi.waitFor(() => {
      expect(onselect).toHaveBeenCalled();
    });
    expect(onselect.mock.calls[0]?.[0]?.id).toBe("ch:chn_proj");
  });
});

describe("ChatSidebar boot when the roster already has a company", () => {
  it("opens the company's channel once it hydrates instead of racing into #setup", async () => {
    const onselect = vi.fn();
    const wakes = createChatWakeBus();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        companies: [ACME],
        wakes,
        onselect,
        bootTimeoutMs: 40,
      },
    });
    // The directory settled empty; the old behaviour opened #setup here
    // (well inside the extra 40ms wait the roster company earns).
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(onselect).not.toHaveBeenCalled();

    wakes.emit("channel:updated", {
      channelId: "chn_acme",
      name: "acme",
      scope: "company",
      companyUid: "cmp_acme",
      membership: "joined",
    });
    await vi.waitFor(() => {
      expect(onselect).toHaveBeenCalled();
    });
    expect(onselect.mock.calls[0]?.[0]?.id).toBe("ch:chn_acme");
    expect(onselect.mock.calls.some((call) => call[0]?.id === SETUP_ROW_ID)).toBe(false);
  });

  it("still falls back to #setup after the bounded wait when no company rows arrive", async () => {
    const onselect = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        companies: [ACME],
        onselect,
        bootTimeoutMs: 40,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(onselect).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(onselect).toHaveBeenCalled();
    });
    expect(onselect.mock.calls[0]?.[0]?.id).toBe(SETUP_ROW_ID);
  });

  it("opens #setup right after boot when the roster has no company", async () => {
    const onselect = vi.fn();
    const started = Date.now();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        companies: [],
        onselect,
        bootTimeoutMs: 40,
      },
    });
    await vi.waitFor(() => {
      expect(onselect).toHaveBeenCalled();
    });
    expect(onselect.mock.calls[0]?.[0]?.id).toBe(SETUP_ROW_ID);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
