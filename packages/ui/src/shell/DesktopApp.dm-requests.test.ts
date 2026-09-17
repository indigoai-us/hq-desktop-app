// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import {
  createChatWakeBus,
  type ChatSidebarApi,
  type NotificationsApi,
} from "../chat/chat-api.js";
import type { DmRequest } from "../chat/dm-requests.js";
import { requestDmRequestsOpen, takePendingDmRequests } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

function webAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok({ members: [] }),
    },
  } as unknown as PlatformAdapter;
}

const projectRow: ConversationRow = {
  id: "ch:chn_proj",
  kind: "channel",
  title: "launch",
  companyUid: "cmp_acme",
  unreadDot: false,
  lastActivityAt: Date.parse("2026-09-10T00:00:00.000Z"),
  pinned: false,
  channelId: "chn_proj",
};

const ADA: DmRequest = {
  pairKey: "pk_ada",
  fromPersonUid: "prs_ada",
  fromEmail: "ada@example.com",
  fromDisplayName: "Ada Lovelace",
  message: "Hello!",
  createdAt: "2026-09-10T00:00:00.000Z",
};

const notificationsApi: NotificationsApi = {
  fetchNotifications: async () => ({
    notifications: [],
    unreadCount: 0,
    nextCursor: null,
  }),
  ackNotification: async () => {},
  readAllNotifications: async () => {},
  runNotificationAction: async () => ({}),
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function mountApp(sidebarApi: ChatSidebarApi, wakes = createChatWakeBus()) {
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: webAdapter(),
      sidebarApi,
      notificationsApi,
      wakes,
      initialRow: projectRow,
      searchRows: [projectRow],
      self: { uid: "prs_me", displayName: "Me", email: "me@example.com" },
      coreFixtures: false,
    },
  });
  return wakes;
}

beforeEach(() => {
  window.localStorage?.clear?.();
  takePendingDmRequests();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  takePendingDmRequests();
});

describe("DesktopApp connection requests", () => {
  it("opens the Requests panel from the sidebar's connection-requests row", async () => {
    const sidebarApi: ChatSidebarApi = {
      ...createFixtureChatSidebarApi(),
      listDmRequests: async () => ({ requests: [ADA] }),
    };
    mountApp(sidebarApi);
    await tick();
    await vi.waitFor(
      () =>
        expect(
          host.querySelector('[data-testid="chat-connection-requests"]'),
        ).toBeTruthy(),
      { timeout: 10_000, interval: 50 },
    );
    expect(host.querySelector('[data-testid="dm-requests-panel"]')).toBeNull();

    host
      .querySelector<HTMLButtonElement>('[data-testid="chat-connection-requests"]')!
      .click();
    await vi.waitFor(
      () =>
        expect(host.querySelector('[data-testid="dm-requests-panel"]')).toBeTruthy(),
      { timeout: 10_000, interval: 50 },
    );
    await vi.waitFor(() =>
      expect(
        host.querySelector('[data-testid="dm-request-card"]')?.getAttribute("data-pair-key"),
      ).toBe("pk_ada"),
    );
    // The open was consumed — nothing is left stashed for a later mount.
    expect(takePendingDmRequests()).toBeNull();

    host.querySelector<HTMLButtonElement>('[data-testid="dm-requests-back"]')!.click();
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="dm-requests-panel"]')).toBeNull(),
    );
  }, 30_000);

  it("honours a request stashed before mount (cold open)", async () => {
    requestDmRequestsOpen("pk_ada");
    const sidebarApi: ChatSidebarApi = {
      ...createFixtureChatSidebarApi(),
      listDmRequests: async () => ({ requests: [ADA] }),
    };
    mountApp(sidebarApi);
    await vi.waitFor(
      () =>
        expect(host.querySelector('[data-testid="dm-requests-panel"]')).toBeTruthy(),
      { timeout: 10_000, interval: 50 },
    );
  }, 30_000);

  it("accepting a request opens the conversation with the requester and emits dm:request-update", async () => {
    const respondDmRequest = vi.fn(async () => {});
    const sidebarApi: ChatSidebarApi = {
      ...createFixtureChatSidebarApi(),
      listDmRequests: async () => ({ requests: [ADA] }),
      respondDmRequest,
    };
    const wakes = mountApp(sidebarApi);
    const updates: Array<{ pairKey: string }> = [];
    wakes.on("dm:request-update", (payload) => updates.push(payload));
    requestDmRequestsOpen();
    await vi.waitFor(
      () =>
        expect(host.querySelector('[data-testid="dm-request-accept"]')).toBeTruthy(),
      { timeout: 10_000, interval: 50 },
    );

    host.querySelector<HTMLButtonElement>('[data-testid="dm-request-accept"]')!.click();
    await vi.waitFor(
      () => {
        expect(host.querySelector('[data-testid="dm-requests-panel"]')).toBeNull();
        expect(
          host.querySelector('[data-testid="channel-header"]')?.textContent,
        ).toContain("Ada Lovelace");
      },
      { timeout: 10_000, interval: 50 },
    );
    expect(respondDmRequest).toHaveBeenCalledWith({ pairKey: "pk_ada", action: "accept" });
    expect(updates).toEqual([{ pairKey: "pk_ada" }]);
  }, 30_000);

  it("declining keeps the Requests panel open", async () => {
    const sidebarApi: ChatSidebarApi = {
      ...createFixtureChatSidebarApi(),
      listDmRequests: async () => ({ requests: [ADA] }),
      respondDmRequest: async () => {},
    };
    mountApp(sidebarApi);
    requestDmRequestsOpen();
    await vi.waitFor(
      () =>
        expect(host.querySelector('[data-testid="dm-request-decline"]')).toBeTruthy(),
      { timeout: 10_000, interval: 50 },
    );
    host.querySelector<HTMLButtonElement>('[data-testid="dm-request-decline"]')!.click();
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="dm-requests-empty"]')).toBeTruthy(),
    );
    expect(host.querySelector('[data-testid="dm-requests-panel"]')).toBeTruthy();
  }, 30_000);
});
