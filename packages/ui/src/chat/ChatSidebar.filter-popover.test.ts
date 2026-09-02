// @vitest-environment happy-dom

/**
 * Filter popover: viewport-aware placement, rail-sized width, Esc / outside
 * click dismiss. The previous bottom-end `right:` placement grew a ~490px
 * panel past the left edge of the window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import {
  FILTER_POPOVER_MAX_PX,
  FILTER_POPOVER_RAIL_OVERHANG_PX,
  VIEWPORT_MARGIN_PX,
} from "./popover-placement.js";

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

function rect(x: number, y: number, w: number, h: number): DOMRect {
  return {
    x,
    y,
    width: w,
    height: h,
    top: y,
    left: x,
    right: x + w,
    bottom: y + h,
    toJSON() {
      return {};
    },
  } as DOMRect;
}

async function mountRail() {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(ChatSidebar, {
    target: host,
    props: { api: stubApi(), seedDirectory: [seedRow] },
  });
  await vi.waitFor(() => {
    expect(host.querySelector('[data-testid="chat-filter"]')).toBeTruthy();
  });
}

async function openFilter() {
  host.querySelector<HTMLButtonElement>('[data-testid="chat-filter"]')!.click();
  await tick();
  const popover = document.querySelector<HTMLElement>(
    '[data-testid="chat-filter-popover"]',
  );
  expect(popover, "filter popover open").toBeTruthy();
  return popover!;
}

beforeEach(() => {
  window.localStorage?.clear?.();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document
    .querySelectorAll('[data-testid="chat-filter-popover"]')
    .forEach((n) => n.remove());
  window.localStorage?.clear?.();
  vi.restoreAllMocks();
});

describe("ChatSidebar filter popover", () => {
  it("stays inside a 1000px window when the rail is 320px and content wants 490px", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    const origRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const el = this as HTMLElement;
        if (
          el.classList?.contains("chat-sidebar") ||
          el.getAttribute("data-testid") === "chat-sidebar"
        ) {
          return rect(0, 0, 320, 800);
        }
        if (
          el.classList?.contains("chat-filter-wrap") ||
          el.getAttribute("data-testid") === "chat-filter"
        ) {
          return rect(292, 8, 28, 28);
        }
        return origRect.call(this);
      },
    );
    const origOffset = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetWidth",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        if (this.getAttribute?.("data-testid") === "chat-filter-popover") {
          return 490;
        }
        return origOffset?.get?.call(this) ?? 0;
      },
    });

    await mountRail();
    const popover = await openFilter();

    const left = parseFloat(popover.style.left || "0");
    const width = parseFloat(popover.style.width || "0");
    expect(left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
    expect(width).toBeLessThanOrEqual(FILTER_POPOVER_MAX_PX);
    expect(width).toBeLessThanOrEqual(320 + FILTER_POPOVER_RAIL_OVERHANG_PX);
    expect(left + width).toBeLessThanOrEqual(1000 - VIEWPORT_MARGIN_PX);
    expect(popover.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);

    if (origOffset) {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", origOffset);
    }
  });

  it("closes on Escape", async () => {
    await mountRail();
    await openFilter();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await tick();
    expect(
      document.querySelector('[data-testid="chat-filter-popover"]'),
    ).toBeNull();
  });

  it("closes on an outside click", async () => {
    await mountRail();
    await openFilter();
    document.body.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    await tick();
    expect(
      document.querySelector('[data-testid="chat-filter-popover"]'),
    ).toBeNull();
  });
});
