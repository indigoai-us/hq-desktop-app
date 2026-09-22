// @vitest-environment happy-dom

/**
 * Sidebar sessions: multi-select, archive, and the "Show archived" filter row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import { ARCHIVED_STORAGE_KEY } from "./session-archive.js";
import { tenantStorageKey } from "../identity/tenant-storage.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const NOW = new Date().toISOString();

const seedRows: ChannelDirectoryRow[] = [
  {
    channelId: "chn_alpha",
    type: "project",
    scope: "project",
    companyUid: "cmp_1",
    name: "alpha",
    lastActivityAt: NOW,
  },
  {
    channelId: "chn_beta",
    type: "project",
    scope: "project",
    companyUid: "cmp_1",
    name: "beta",
    lastActivityAt: NOW,
    unreadCount: 3,
  },
  {
    channelId: "chn_gamma",
    type: "project",
    scope: "project",
    companyUid: "cmp_1",
    name: "gamma",
    lastActivityAt: NOW,
  },
];

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: seedRows,
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

const TENANT = { accountId: "acct_ada", companyId: "cmp_1" };

/** Rendered rail rows, in paint order. */
function renderedIds(): string[] {
  return [...host.querySelectorAll<HTMLElement>(".chat-row[data-conversation-id]")].map(
    (el) => el.dataset.conversationId!,
  );
}

async function mountRail(waitFor: string[] = ["chn_alpha", "chn_gamma"]) {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(ChatSidebar, {
    target: host,
    props: {
      api: stubApi(),
      seedDirectory: seedRows,
      tenantAccountId: TENANT.accountId,
      tenantCompanyId: TENANT.companyId,
      // A host selection keeps the rail's auto-open off, so unread rows stay
      // unread and the painted order is stable across these tests.
      selectedId: "ch:chn_alpha",
    },
  });
  await vi.waitFor(() => {
    for (const id of waitFor) expect(rowFor(id)).toBeTruthy();
  });
}

function rowFor(channelId: string): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(
    `.chat-row[data-conversation-id="ch:${channelId}"]`,
  );
}

function clickRow(channelId: string, modifiers: MouseEventInit = {}) {
  rowFor(channelId)!.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers }),
  );
}

function rightClickRow(channelId: string) {
  rowFor(channelId)!.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
  );
}

function portalQuery<T extends HTMLElement>(testId: string): T | null {
  return document.querySelector<T>(`[data-testid="${testId}"]`);
}

async function openFilter() {
  host.querySelector<HTMLButtonElement>('[data-testid="chat-filter"]')!.click();
  await tick();
  return portalQuery<HTMLElement>("chat-filter-popover")!;
}

beforeEach(() => {
  window.localStorage?.clear?.();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document
    .querySelectorAll(
      '[data-testid="chat-filter-popover"], [data-testid="chat-context-menu"]',
    )
    .forEach((n) => n.remove());
  window.localStorage?.clear?.();
  vi.restoreAllMocks();
});

describe("ChatSidebar sessions multi-select + archive", () => {
  it("cmd-click enters selection mode without opening the row", async () => {
    await mountRail();
    clickRow("chn_alpha", { metaKey: true });
    await tick();

    expect(portalQuery("chat-selection-bar")).toBeTruthy();
    expect(portalQuery("chat-selection-count")!.textContent).toContain(
      "1 selected",
    );
    expect(rowFor("chn_alpha")!.getAttribute("aria-selected")).toBe("true");
    expect(rowFor("chn_beta")!.getAttribute("aria-selected")).toBe("false");
    expect(
      host
        .querySelector('[data-testid="chat-conversation-list"]')!
        .getAttribute("aria-multiselectable"),
    ).toBe("true");
  });

  it("shift-click selects the rendered range", async () => {
    await mountRail();
    const order = renderedIds();
    const first = order.indexOf("ch:chn_alpha");
    const last = order.indexOf("ch:chn_gamma");
    const expected = order.slice(
      Math.min(first, last),
      Math.max(first, last) + 1,
    );
    expect(expected.length).toBeGreaterThan(1);

    clickRow("chn_alpha", { metaKey: true });
    await tick();
    clickRow("chn_gamma", { shiftKey: true });
    await tick();

    expect(portalQuery("chat-selection-count")!.textContent).toContain(
      `${expected.length} selected`,
    );
    const selected = [
      ...host.querySelectorAll<HTMLElement>('.chat-row[aria-selected="true"]'),
    ].map((el) => el.dataset.conversationId!);
    expect(selected).toEqual(expected);
  });

  it("Escape clears the selection and leaves selection mode", async () => {
    await mountRail();
    clickRow("chn_alpha", { metaKey: true });
    await tick();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await tick();

    expect(portalQuery("chat-selection-bar")).toBeNull();
    expect(rowFor("chn_alpha")!.hasAttribute("aria-selected")).toBe(false);
  });

  it("bulk archive removes the selected rows from the default rail", async () => {
    await mountRail();
    clickRow("chn_alpha", { metaKey: true });
    await tick();
    clickRow("chn_beta", { metaKey: true });
    await tick();
    portalQuery<HTMLButtonElement>("chat-selection-archive")!.click();
    await tick();

    expect(rowFor("chn_alpha")).toBeNull();
    expect(rowFor("chn_beta")).toBeNull();
    expect(rowFor("chn_gamma")).toBeTruthy();
    expect(portalQuery("chat-selection-bar")).toBeNull();

    const stored = window.localStorage.getItem(
      tenantStorageKey(TENANT, ARCHIVED_STORAGE_KEY),
    );
    expect(JSON.parse(stored!)).toEqual(["ch:chn_alpha", "ch:chn_beta"]);
  });

  it("archives and unarchives one row from the context menu", async () => {
    await mountRail();
    rightClickRow("chn_alpha");
    await tick();
    const archiveItem = portalQuery<HTMLButtonElement>("chat-context-archive")!;
    expect(archiveItem.textContent).toContain("Archive conversation");
    archiveItem.click();
    await tick();
    expect(rowFor("chn_alpha")).toBeNull();

    const popover = await openFilter();
    popover
      .querySelector<HTMLButtonElement>('[data-testid="chat-filter-archived"]')!
      .click();
    await tick();

    const restored = rowFor("chn_alpha")!;
    expect(restored).toBeTruthy();
    expect(
      restored.querySelector('[data-testid="chat-row-archived-pill"]'),
    ).toBeTruthy();

    rightClickRow("chn_alpha");
    await tick();
    const unarchiveItem = portalQuery<HTMLButtonElement>(
      "chat-context-archive",
    )!;
    expect(unarchiveItem.textContent).toContain("Unarchive conversation");
    unarchiveItem.click();
    await tick();
    expect(
      rowFor("chn_alpha")!.querySelector(
        '[data-testid="chat-row-archived-pill"]',
      ),
    ).toBeNull();
  });

  it("keeps unread state through an archive round trip", async () => {
    await mountRail();
    expect(rowFor("chn_beta")!.className).toContain("unread");

    rightClickRow("chn_beta");
    await tick();
    portalQuery<HTMLButtonElement>("chat-context-archive")!.click();
    await tick();
    expect(rowFor("chn_beta")).toBeNull();

    const popover = await openFilter();
    popover
      .querySelector<HTMLButtonElement>('[data-testid="chat-filter-archived"]')!
      .click();
    await tick();
    rightClickRow("chn_beta");
    await tick();
    portalQuery<HTMLButtonElement>("chat-context-archive")!.click();
    await tick();

    const restored = rowFor("chn_beta")!;
    expect(restored.className).toContain("unread");
    expect(restored.textContent).toContain("3");
  });

  it("the Show archived row toggles archived visibility and normal rows stay", async () => {
    await mountRail();
    rightClickRow("chn_alpha");
    await tick();
    portalQuery<HTMLButtonElement>("chat-context-archive")!.click();
    await tick();

    const popover = await openFilter();
    const toggle = popover.querySelector<HTMLButtonElement>(
      '[data-testid="chat-filter-archived"]',
    )!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(
      toggle.querySelector('[data-testid="chat-filter-archived-count"]')!
        .textContent,
    ).toContain("1");
    toggle.click();
    await tick();

    expect(rowFor("chn_alpha")).toBeTruthy();
    expect(rowFor("chn_beta")).toBeTruthy();
    expect(rowFor("chn_gamma")).toBeTruthy();
    expect(
      rowFor("chn_beta")!.querySelector(
        '[data-testid="chat-row-archived-pill"]',
      ),
    ).toBeNull();

    // The toggle stays put (the popover does not close), now checked.
    expect(
      portalQuery("chat-filter-archived")!.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("the context menu can start selection mode for mouse-only users", async () => {
    await mountRail();
    rightClickRow("chn_beta");
    await tick();
    portalQuery<HTMLButtonElement>("chat-context-select")!.click();
    await tick();

    expect(portalQuery("chat-selection-count")!.textContent).toContain(
      "1 selected",
    );
    expect(rowFor("chn_beta")!.getAttribute("aria-selected")).toBe("true");

    const painted = renderedIds().length;
    portalQuery<HTMLButtonElement>("chat-selection-all")!.click();
    await tick();
    expect(portalQuery("chat-selection-count")!.textContent).toContain(
      `${painted} selected`,
    );
  });

  it("restores archive state for the tenant on remount", async () => {
    window.localStorage.setItem(
      tenantStorageKey(TENANT, ARCHIVED_STORAGE_KEY),
      JSON.stringify(["ch:chn_gamma"]),
    );
    await mountRail(["chn_alpha"]);
    expect(rowFor("chn_gamma")).toBeNull();
    expect(rowFor("chn_alpha")).toBeTruthy();
  });
});
