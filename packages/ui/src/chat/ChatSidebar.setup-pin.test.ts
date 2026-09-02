// @vitest-environment happy-dom

/**
 * The synthetic #setup channel is pinned BY DEFAULT for a fresh profile. The
 * user can unpin it and it must STAY unpinned (tenant-scoped, survives a
 * remount) until they pin it again — the rail used to re-add the pin on every
 * render so unpinning was silently undone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import { SETUP_ROW_ID } from "./setup-channel";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const seedRow: ChannelDirectoryRow = {
  channelId: "chn_proj",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  name: "launch",
  lastActivityAt: new Date().toISOString(),
};

function stubApi(): ChatSidebarApi {
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
  };
}

async function mountRail(): Promise<void> {
  component = mount(ChatSidebar, {
    target: host,
    props: {
      api: stubApi(),
      seedDirectory: [seedRow],
      // A real tenant so the rail's storage is not the no-op facade.
      tenantAccountId: "acct_test",
      tenantCompanyId: "all",
    },
  });
  await vi.waitFor(() => {
    expect(
      host.querySelector('[data-conversation-id="ch:chn_proj"]'),
    ).toBeTruthy();
  });
}

async function remountRail(): Promise<void> {
  if (component) await unmount(component);
  component = null;
  host.innerHTML = "";
  await mountRail();
}

const pinnedIds = () =>
  Array.from(
    host.querySelectorAll(
      '[aria-labelledby="chat-pinned-label"] [data-conversation-id]',
    ),
  ).map((el) => el.getAttribute("data-conversation-id"));

const allIds = () =>
  Array.from(host.querySelectorAll("[data-conversation-id]")).map((el) =>
    el.getAttribute("data-conversation-id"),
  );

function pinButtonFor(rowId: string): HTMLButtonElement {
  const rowBtn = host.querySelector(`[data-conversation-id="${rowId}"]`);
  const btn = rowBtn?.parentElement?.querySelector<HTMLButtonElement>(
    '[data-testid="chat-pin"]',
  );
  expect(btn, `pin button for ${rowId}`).toBeTruthy();
  return btn!;
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

describe("ChatSidebar #setup default pin", () => {
  it("is pinned for a fresh profile", async () => {
    await mountRail();
    expect(pinnedIds()).toEqual([SETUP_ROW_ID]);
    expect(pinButtonFor(SETUP_ROW_ID).getAttribute("aria-label")).toBe(
      "Unpin setup",
    );
  });

  it("unpin via the hover button sticks, survives a remount, and re-pin restores it", async () => {
    await mountRail();

    pinButtonFor(SETUP_ROW_ID).click();
    await tick();
    expect(pinnedIds()).not.toContain(SETUP_ROW_ID);
    // Still in the rail — just in the normal list, not hidden in LAST WEEK.
    expect(allIds()).toContain(SETUP_ROW_ID);
    expect(
      host.querySelector('[data-testid="chat-last-week"]'),
      "no collapsed LAST WEEK bucket appears for the unpinned setup row",
    ).toBeNull();
    expect(pinButtonFor(SETUP_ROW_ID).getAttribute("aria-label")).toBe(
      "Pin setup",
    );
    // Persisted under the tenant scope.
    const dismissedKey = Object.keys(window.localStorage).find((k) =>
      k.endsWith("hq.chat.setup-pin-dismissed"),
    );
    expect(dismissedKey).toContain("acct_test");
    expect(window.localStorage.getItem(dismissedKey!)).toBe("1");

    // Same storage, fresh mount → still unpinned.
    await remountRail();
    expect(pinnedIds()).not.toContain(SETUP_ROW_ID);
    expect(allIds()).toContain(SETUP_ROW_ID);

    // Re-pin → back in PINNED and the sticky flag is cleared.
    pinButtonFor(SETUP_ROW_ID).click();
    await tick();
    expect(pinnedIds()).toContain(SETUP_ROW_ID);
    expect(window.localStorage.getItem(dismissedKey!)).toBeNull();

    await remountRail();
    expect(pinnedIds()).toContain(SETUP_ROW_ID);
  });

  it("unpin via the context menu sticks too", async () => {
    await mountRail();
    host
      .querySelector(`[data-conversation-id="${SETUP_ROW_ID}"]`)!
      .dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 40,
        }),
      );
    await tick();
    const menuPin = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-context-pin"]',
    );
    expect(menuPin?.textContent).toContain("Unpin");
    menuPin!.click();
    await tick();
    expect(pinnedIds()).not.toContain(SETUP_ROW_ID);
    expect(allIds()).toContain(SETUP_ROW_ID);
    await remountRail();
    expect(pinnedIds()).not.toContain(SETUP_ROW_ID);
  });

  it("does not change how other rows pin and unpin", async () => {
    await mountRail();
    pinButtonFor("ch:chn_proj").click();
    await tick();
    expect(pinnedIds().sort()).toEqual([SETUP_ROW_ID, "ch:chn_proj"].sort());
    // Unpinning #setup leaves the other pin alone.
    pinButtonFor(SETUP_ROW_ID).click();
    await tick();
    expect(pinnedIds()).toEqual(["ch:chn_proj"]);
    pinButtonFor("ch:chn_proj").click();
    await tick();
    expect(pinnedIds()).toEqual([]);
    expect(allIds()).toContain("ch:chn_proj");
    expect(allIds()).toContain(SETUP_ROW_ID);
  });
});
