// @vitest-environment happy-dom

/**
 * Production bug: a signed-in user outside the former Indigo cohort got the
 * new workspace shell with only #setup in the rail and an infinite grey
 * conversation skeleton. The directory/contacts/dm-threads reads 404'd or
 * hung, auto-open skipped #setup, and selectedRow stayed null.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus, type ChatSidebarApi } from "../chat/chat-api.js";
import { SETUP_ROW_ID } from "../chat/setup-channel.js";

function adapter(): PlatformAdapter {
  return {
    kind: "desktop",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => failure("http-404", "Not found"),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => failure("http-404", "Not found"),
      fetchDmThread: async () => ok({ messages: [] }),
      markChannelRead: async () => ok(undefined),
    },
    notifications: {
      fetchDmInbox: async () => failure("http-404", "Not found"),
      fetchDmThreads: async () => failure("http-404", "Not found"),
    },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({
        ok: false as const,
        reason: "unavailable",
      }),
    },
  } as unknown as PlatformAdapter;
}

function emptyFeed() {
  return {
    snapshot: true,
    cursor: "cur_empty",
    cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    rows: [],
  };
}

function sidebarApi(overrides: Partial<ChatSidebarApi> = {}): ChatSidebarApi {
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

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  vi.useRealTimers();
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage?.clear?.();
});

async function mountApp(api: ChatSidebarApi, bootTimeoutMs = 40): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(),
      sidebarApi: api,
      notificationsApi: createEmptyNotificationsApi(),
      wakes: createChatWakeBus(),
      self: {
        uid: "prs_michel",
        displayName: "Michel Triana",
        email: "michel@example.com",
      },
      tenantAccountId: "acct_michel",
      coreFixtures: false,
      bootTimeoutMs,
    },
  });
  await tick();
}

describe("DesktopApp first paint for a non-cohort / empty tenant", () => {
  it("opens #setup instead of an infinite skeleton when the directory 404s", async () => {
    await mountApp(
      sidebarApi({
        fetchChannelDirectory: async () => {
          throw new Error("[http-404] GET /v1/notify/channels failed");
        },
      }),
    );

    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="setup-channel-intro"]'),
      ).toBeTruthy();
    });
    expect(host.querySelector('[data-testid="channel-skeleton"]')).toBeNull();
    expect(
      host.querySelector(`[data-conversation-id="${SETUP_ROW_ID}"]`),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="conversation-composer"]'),
    ).toBeTruthy();
  });

  it("opens #setup within the timeout when the directory never returns", async () => {
    await mountApp(
      sidebarApi({
        fetchChannelDirectory: () => new Promise(() => {}),
        listContacts: () => new Promise(() => {}),
      }),
      40,
    );

    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="setup-channel-intro"]'),
      ).toBeTruthy();
    });
    expect(host.querySelector('[data-testid="channel-skeleton"]')).toBeNull();
  });
});
