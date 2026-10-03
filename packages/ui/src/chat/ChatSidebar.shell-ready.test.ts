// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import { shouldReportShellReady } from "./shell-ready.js";

describe("shouldReportShellReady", () => {
  it("reports after conversations have painted", () => {
    expect(
      shouldReportShellReady({
        loading: false,
        loadError: null,
        firstRefreshSettled: false,
        conversationCount: 3,
      }),
    ).toBe(true);
  });

  it("reports an empty state only after the first fetch settles", () => {
    expect(
      shouldReportShellReady({
        loading: true,
        loadError: null,
        firstRefreshSettled: false,
        conversationCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldReportShellReady({
        loading: false,
        loadError: null,
        firstRefreshSettled: true,
        conversationCount: 0,
      }),
    ).toBe(true);
  });

  it("does not report error states, even after the fetch settles", () => {
    expect(
      shouldReportShellReady({
        loading: false,
        loadError: "Could not load conversations",
        firstRefreshSettled: true,
        conversationCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldReportShellReady({
        loading: false,
        loadError: "Could not load conversations",
        firstRefreshSettled: true,
        conversationCount: 2,
      }),
    ).toBe(false);
  });
});

const seedRow: ChannelDirectoryRow = {
  channelId: "chn_proj",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  name: "launch",
  lastActivityAt: new Date().toISOString(),
};

const ROSTER_ERROR = "Couldn’t load conversations.";

function stubApi(fail: boolean, rosterGate?: Promise<void>): ChatSidebarApi {
  const cursor = "a".repeat(32);
  const feed = {
    snapshot: true,
    cursor,
    cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    rows: [] as ChannelDirectoryRow[],
  };
  return {
    fetchChannelDirectory: async () => {
      await rosterGate;
      if (fail) throw new Error("directory down");
      return feed;
    },
    listContacts: async () => {
      await rosterGate;
      if (fail) throw new Error("contacts down");
      return { contacts: [] };
    },
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

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

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

async function mountRail(opts: {
  onShellReady: () => void;
  seed?: ChannelDirectoryRow[];
  fail?: boolean;
  rosterGate?: Promise<void>;
}): Promise<void> {
  component = mount(ChatSidebar, {
    target: host,
    props: {
      api: stubApi(opts.fail ?? false, opts.rosterGate),
      seedDirectory: opts.seed ?? null,
      tenantAccountId: "acct_shell_ready",
      tenantCompanyId: "all",
      bootTimeoutMs: 40,
      onShellReady: opts.onShellReady,
    },
  });
}

describe("ChatSidebar reports shell ready through shouldReportShellReady", () => {
  it("calls onShellReady once a seeded conversation has painted", async () => {
    const onShellReady = vi.fn();
    await mountRail({ onShellReady, seed: [seedRow] });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-conversation-id="ch:chn_proj"]')).toBeTruthy();
      expect(onShellReady).toHaveBeenCalledTimes(1);
    });
  });

  it("calls onShellReady for an empty roster after the first fetch settles", async () => {
    const onShellReady = vi.fn();
    let releaseRoster!: () => void;
    const rosterGate = new Promise<void>((resolve) => {
      releaseRoster = resolve;
    });
    await mountRail({ onShellReady, rosterGate });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onShellReady).not.toHaveBeenCalled();
    releaseRoster();
    await vi.waitFor(() => expect(onShellReady).toHaveBeenCalledTimes(1));
    expect(host.textContent).not.toContain(ROSTER_ERROR);
  });

  it("does not call onShellReady when the roster fails", async () => {
    const onShellReady = vi.fn();
    await mountRail({ onShellReady, fail: true });
    await vi.waitFor(() => expect(host.textContent).toContain(ROSTER_ERROR));
    expect(onShellReady).not.toHaveBeenCalled();
  });
});
