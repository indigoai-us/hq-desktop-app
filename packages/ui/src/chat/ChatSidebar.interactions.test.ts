// @vitest-environment happy-dom

/**
 * Interaction regression tests for the chat sidebar.
 *
 * Right-click on a conversation used to pin it outright. It now opens a
 * context menu at the cursor; only clicking the menu item pins/unpins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import { createChatWakeBus, type ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

// Real "now" so rows land in the TODAY group and are not collapsed out of the
// visible rail (day grouping uses the test process clock).
const now = () => new Date().toISOString();

const seedRow: ChannelDirectoryRow = {
  channelId: "chn_proj",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  name: "launch",
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
  document
    .querySelectorAll('[data-testid="chat-context-menu"]')
    .forEach((n) => n.remove());
  window.localStorage?.clear?.();
});

describe("ChatSidebar right-click context menu", () => {
  it("right-click opens a Pin menu instead of pinning outright; the menu pins on click", async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stubApi(), seedDirectory: [seedRow] },
    });

    let rowBtn: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      rowBtn = host.querySelector<HTMLButtonElement>(
        '[data-conversation-id="ch:chn_proj"]',
      );
      expect(rowBtn).toBeTruthy();
    });

    // Right-click: opens the context menu, does NOT pin the row.
    rowBtn!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 40,
      }),
    );
    await tick();

    expect(
      document.querySelector('[data-testid="chat-context-menu"]'),
    ).toBeTruthy();
    // No pinned section yet — right-click alone must not pin.
    expect(host.querySelector("#chat-pinned-label")).toBeNull();

    // Click "Pin conversation" — now it pins.
    const pinBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-context-pin"]',
    );
    expect(pinBtn?.textContent).toContain("Pin conversation");
    pinBtn!.click();
    await tick();

    expect(host.querySelector("#chat-pinned-label")).toBeTruthy();
    // Menu closes after acting.
    expect(
      document.querySelector('[data-testid="chat-context-menu"]'),
    ).toBeNull();
  });
});

describe("ChatSidebar sign out", () => {
  it("asks before signing out from the identity menu", async () => {
    const onsignout = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: [seedRow],
        accountLabel: "Stefan Johnson",
        onsignout,
      },
    });
    await tick();
    host
      .querySelector<HTMLButtonElement>('[data-testid="chat-user-card"]')
      ?.click();
    await tick();
    const signOut = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-sign-out"]',
    );
    expect(signOut).toBeTruthy();
    signOut?.click();
    await tick();
    expect(
      document.querySelector('[data-testid="confirm-dialog"]'),
    ).toBeTruthy();
    expect(onsignout).not.toHaveBeenCalled();
    document
      .querySelector<HTMLButtonElement>('[data-testid="confirm-dialog-ok"]')
      ?.click();
    await tick();
    expect(onsignout).toHaveBeenCalledTimes(1);
  });
});

describe("ChatSidebar filters", () => {
  it("selecting a person then a Show filter does not empty the list (stale person filter is cleared)", async () => {
    const api = stubApi({
      listContacts: async () => ({
        contacts: [
          {
            personUid: "prs_ada",
            displayName: "Ada Lovelace",
            companyUid: "cmp_1",
            lastActivityAt: now(),
          },
        ],
      }),
    });
    component = mount(ChatSidebar, {
      target: host,
      props: { api, seedDirectory: [seedRow] },
    });

    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-conversation-id="ch:chn_proj"]'),
      ).toBeTruthy();
    });

    const openFilter = () => {
      host
        .querySelector<HTMLButtonElement>('[data-testid="chat-filter"]')!
        .click();
    };
    const filterButton = (text: string) =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[data-testid="chat-filter-popover"] button',
        ),
      ].find((b) => b.textContent?.includes(text));

    // Pick the person (narrows to their DMs), then switch Show → Project channels.
    openFilter();
    await vi.waitFor(() => expect(filterButton("Ada Lovelace")).toBeTruthy());
    filterButton("Ada Lovelace")!.click();
    await tick();
    openFilter();
    await tick();
    const projectsBtn = filterButton("Project channels");
    expect(projectsBtn, "Project channels filter").toBeTruthy();
    projectsBtn!.click();
    await tick();

    // With the stale person filter cleared, the project channel is still shown.
    // (Before the fix, person + "projects" composed to an empty list.)
    expect(
      host.querySelector('[data-conversation-id="ch:chn_proj"]'),
    ).toBeTruthy();
  });
});

describe("ChatSidebar auto-opens a conversation (US-016)", () => {
  it("calls onselect with the seeded channel when selectedId is null", async () => {
    const onselect = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stubApi(), seedDirectory: [seedRow], onselect },
    });
    await vi.waitFor(() => {
      expect(onselect).toHaveBeenCalled();
    });
    expect(onselect.mock.calls[0]?.[0]?.id).toBe("ch:chn_proj");
  });

  it("does not auto-select when the shell already has a selectedId", async () => {
    const onselect = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: [seedRow],
        selectedId: "ch:chn_proj",
        onselect,
      },
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-conversation-id="ch:chn_proj"]'),
      ).toBeTruthy();
    });
    await tick();
    expect(onselect).not.toHaveBeenCalled();
  });
});

describe("ChatSidebar unread badge on off-screen channel wake (US-019)", () => {
  it("shows a numeric badge after channel:new-message when another row is selected", async () => {
    const wakes = createChatWakeBus();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: [seedRow],
        selectedId: "dm:agt_deacon",
        wakes,
        self: { uid: "prs_stefan" },
      },
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-conversation-id="ch:chn_proj"]'),
      ).toBeTruthy();
    });
    expect(host.querySelector('[data-testid="chat-unread-badge"]')).toBeNull();
    wakes.emit("channel:new-message", {
      channelId: "chn_proj",
      eventId: "evt_1",
      createdAt: new Date().toISOString(),
      fromPersonUid: "agt_deacon",
    });
    await tick();
    const badge = host.querySelector('[data-testid="chat-unread-badge"]');
    expect(badge?.textContent?.trim()).toBe("1");
  });

  it("uses a native channel wake's absolute unread rollup without undercounting a batch", async () => {
    const wakes = createChatWakeBus();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: [seedRow],
        selectedId: "dm:agt_deacon",
        wakes,
        self: { uid: "prs_stefan" },
      },
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-conversation-id="ch:chn_proj"]')).toBeTruthy();
    });

    wakes.emit("channel:new-message", {
      channelId: "chn_proj",
      unread: 2,
      absoluteUnread: true,
    });
    await tick();

    expect(host.querySelector('[data-testid="chat-unread-badge"]')?.textContent?.trim()).toBe("2");
  });

  it("shows a numeric badge after dm:new-message when another row is selected", async () => {
    const wakes = createChatWakeBus();
    const deacon: ChannelDirectoryRow = {
      channelId: "chn_proj",
      type: "project",
      scope: "project",
      companyUid: "cmp_1",
      name: "launch",
      lastActivityAt: new Date().toISOString(),
    };
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({
          listContacts: async () => ({
            contacts: [
              {
                personUid: "agt_deacon",
                displayName: "Deacon",
                lastActivityAt: now(),
                lastDmAt: now(),
              },
            ],
          }),
        }),
        seedDirectory: [deacon],
        selectedId: "ch:chn_proj",
        wakes,
        self: { uid: "prs_stefan" },
      },
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-conversation-id="dm:agt_deacon"]'),
      ).toBeTruthy();
    });
    wakes.emit("dm:new-message", {
      fromPersonUid: "agt_deacon",
      eventId: "evt_dm",
      createdAt: new Date().toISOString(),
    });
    await tick();
    const row = host.querySelector('[data-conversation-id="dm:agt_deacon"]');
    const badge = row?.querySelector('[data-testid="chat-unread-badge"]');
    expect(badge?.textContent?.trim()).toBe("1");
  });

  it("does not increment after the native pair-unread rollup already set the count", async () => {
    const wakes = createChatWakeBus();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({
          listContacts: async () => ({
            contacts: [
              {
                personUid: "agt_deacon",
                displayName: "Deacon",
                lastActivityAt: now(),
                lastDmAt: now(),
              },
            ],
          }),
        }),
        seedDirectory: [seedRow],
        selectedId: "ch:chn_proj",
        wakes,
        self: { uid: "prs_stefan" },
      },
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-conversation-id="dm:agt_deacon"]')).toBeTruthy();
    });

    wakes.emit("dm:pair-unreads", {
      pairUnreads: [{ withPersonUid: "agt_deacon", unreadCount: 1 }],
    });
    wakes.emit("dm:new-message", {
      fromPersonUid: "agt_deacon",
      eventId: "evt_dm",
      absoluteUnread: true,
    });
    await tick();

    const row = host.querySelector('[data-conversation-id="dm:agt_deacon"]');
    expect(row?.querySelector('[data-testid="chat-unread-badge"]')?.textContent?.trim()).toBe("1");
  });
});
