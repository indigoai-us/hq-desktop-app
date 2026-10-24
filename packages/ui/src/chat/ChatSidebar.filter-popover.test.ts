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
import MessageTypesFilterHarness from "./MessageTypesFilterHarness.test-support.svelte";
import { messageTypesStore } from "./message-types.svelte.js";
import { MESSAGE_TYPES_STORAGE_KEY } from "./message-types.js";
import type { ConversationApi, ConversationMessageWire } from "./chat-api";
import type { ConversationRow } from "./sidebar-model";

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
    logToFile: async () => {},
    ensureCompanyHomeChannel: async (companyUid: string) => ({ homeChannelId: `chn_home_${companyUid}` }),
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

// hq-message-visibility US-004: "Message types" section (global default).
describe("ChatSidebar filter popover: Message types", () => {
  const typesRow: ConversationRow = {
    id: "ch:chn_proj",
    kind: "channel",
    title: "launch",
    companyUid: "cmp_1",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    channelId: "chn_proj",
  };
  const wire: ConversationMessageWire[] = [
    {
      eventId: "evt_person",
      body: "person says hi",
      createdAt: "2026-10-23T01:00:00.000Z",
      fromPersonUid: "prs_ada",
      fromDisplayName: "Ada",
      audience: "human",
    },
    {
      eventId: "evt_agent",
      body: "agent status note",
      createdAt: "2026-10-23T02:00:00.000Z",
      fromPersonUid: "agt_scout",
      fromDisplayName: "Scout",
      audience: "agent",
    },
    {
      eventId: "evt_system",
      body: "system event line",
      createdAt: "2026-10-23T03:00:00.000Z",
      fromDisplayName: "HQ",
      isSystemEvent: true,
    },
  ];
  function conversationApi(): ConversationApi {
    return {
      fetchChannel: async () => ({ messages: wire, nextCursor: null }),
      sendChannelMessage: async () => {},
      fetchDmThread: async () => ({ messages: [], nextCursor: null }),
      sendDm: async () => {},
      fetchReplyThread: async () => ({ scope: "channel", root: null, replies: [], replyCount: 0 }),
      sendReply: async () => {},
      runCardAction: async () => ({ cardId: "", actionId: "", state: "pending" }),
    };
  }

  beforeEach(() => {
    messageTypesStore.reload();
  });

  const sw = (popover: HTMLElement, key: string) =>
    popover.querySelector<HTMLButtonElement>(`[data-testid="chat-filter-type-${key}"]`)!;

  it("renders the caption below Show with People locked on and two switches", async () => {
    await mountRail();
    const popover = await openFilter();
    const captions = [...popover.querySelectorAll(".chat-filter-caption")].map((c) => c.textContent?.trim());
    expect(captions.indexOf("Message types")).toBeGreaterThan(captions.indexOf("Show"));
    expect(captions.indexOf("Show")).toBeGreaterThan(-1);
    const people = sw(popover, "people");
    expect(people.disabled).toBe(true);
    expect(people.getAttribute("role")).toBe("switch");
    expect(people.getAttribute("aria-checked")).toBe("true");
    for (const [key, label] of [["agents", "Agents & CLI"], ["system", "System events"]] as const) {
      const el = sw(popover, key);
      expect(el.getAttribute("role")).toBe("switch");
      expect(el.classList.contains("chat-filter-row")).toBe(true);
      expect(el.querySelector(".chat-filter-lead")).toBeTruthy();
      expect(el.querySelector(".chat-filter-text")?.textContent).toBe(label);
      expect(el.querySelector(".chat-filter-switch")).toBeTruthy();
    }
    expect(popover.querySelector('[data-testid="chat-filter-types-hint"]')?.textContent).toBe(
      "Applies everywhere. Any conversation can override from its header.",
    );
  });

  it("defaults both switches off with nothing stored", async () => {
    await mountRail();
    const popover = await openFilter();
    expect(sw(popover, "agents").getAttribute("aria-checked")).toBe("false");
    expect(sw(popover, "system").getAttribute("aria-checked")).toBe("false");
    expect(window.localStorage.getItem(MESSAGE_TYPES_STORAGE_KEY)).toBeNull();
  });

  it("persists each switch under hq:messages:types.v1 and restores it", async () => {
    await mountRail();
    let popover = await openFilter();
    sw(popover, "agents").click();
    await tick();
    expect(JSON.parse(window.localStorage.getItem("hq:messages:types.v1")!)).toEqual({ agents: true, system: false });
    expect(sw(popover, "agents").getAttribute("aria-checked")).toBe("true");
    sw(popover, "system").click();
    await tick();
    expect(JSON.parse(window.localStorage.getItem("hq:messages:types.v1")!)).toEqual({ agents: true, system: true });

    // A fresh mount reads the stored value back.
    await unmount(component!);
    component = null;
    host.remove();
    document.querySelectorAll('[data-testid="chat-filter-popover"]').forEach((n) => n.remove());
    messageTypesStore.reload();
    await mountRail();
    popover = await openFilter();
    expect(sw(popover, "agents").getAttribute("aria-checked")).toBe("true");
    expect(sw(popover, "system").getAttribute("aria-checked")).toBe("true");
  });

  it("re-filters the open conversation live as switches change", async () => {
    host = document.createElement("div");
    host.className = "desktop-shell chat-shell";
    document.body.appendChild(host);
    component = mount(MessageTypesFilterHarness, {
      target: host,
      props: { api: stubApi(), seedDirectory: [seedRow], conversationApi: conversationApi(), row: typesRow },
    });
    const bodies = () =>
      [...host.querySelectorAll('[data-testid="conversation-message"]')].map((n) => n.textContent ?? "");
    await vi.waitFor(() => expect(bodies().join("|")).toContain("person says hi"));
    expect(bodies().join("|")).not.toContain("agent status note");
    expect(bodies().join("|")).not.toContain("system event line");

    const popover = await openFilter();
    sw(popover, "agents").click();
    await vi.waitFor(() => expect(bodies().join("|")).toContain("agent status note"));
    expect(bodies().join("|")).not.toContain("system event line");

    sw(popover, "system").click();
    await vi.waitFor(() => expect(bodies().join("|")).toContain("system event line"));

    sw(popover, "agents").click();
    await vi.waitFor(() => expect(bodies().join("|")).not.toContain("agent status note"));
    expect(bodies().join("|")).toContain("person says hi");
    expect(bodies().join("|")).toContain("system event line");
  });
});
