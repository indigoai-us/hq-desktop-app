// @vitest-environment happy-dom

/**
 * Archive hides rows until "Show archived" brings them back, including bot
 * conversations that carry normal activity.
 *
 * Selecting or archiving a bot conversation must work exactly like a human
 * conversation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const NOW = new Date().toISOString();

const HUMAN_UID = "prs_marcus";
const TALKATIVE_AGENT = "agt_izzy";
const BOT_UIDS = ["agt_stub0", "agt_stub1", "agt_stub2"];

const seedRow: ChannelDirectoryRow = {
  channelId: "chn_alpha",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  name: "alpha",
  lastActivityAt: NOW,
};

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [seedRow],
    }),
    listContacts: async () => ({
      contacts: [
        ...BOT_UIDS.map((personUid, i) => ({
          personUid,
          displayName: `noticefixture-${i}`,
          lastActivityAt: NOW,
          lastDmAt: NOW,
          unreadCount: 1,
        })),
        {
          personUid: HUMAN_UID,
          displayName: "Marcus Chen",
          email: "m@x.y",
          lastActivityAt: NOW,
          lastDmAt: NOW,
        },
        {
          personUid: TALKATIVE_AGENT,
          displayName: "Izzy",
          lastActivityAt: NOW,
          lastDmAt: NOW,
        },
      ],
    }),
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

const TENANT = { accountId: "acct_ada", companyId: "cmp_1" };

function renderedIds(): string[] {
  return [
    ...host.querySelectorAll<HTMLElement>(".chat-row[data-conversation-id]"),
  ].map((el) => el.dataset.conversationId!);
}

function rowFor(id: string): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>(
    `.chat-row[data-conversation-id="${id}"]`,
  );
}

function portalQuery<T extends HTMLElement>(testId: string): T | null {
  return document.querySelector<T>(`[data-testid="${testId}"]`);
}

async function openFilter(): Promise<void> {
  host.querySelector<HTMLButtonElement>('[data-testid="chat-filter"]')!.click();
  await tick();
}

async function toggleShowArchived(): Promise<void> {
  await openFilter();
  portalQuery<HTMLButtonElement>("chat-filter-archived")!.click();
  await tick();
}

async function mountRail(): Promise<void> {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(ChatSidebar, {
    target: host,
    props: {
      api: stubApi(),
      seedDirectory: [seedRow],
      self: { uid: "prs_me" },
      tenantAccountId: TENANT.accountId,
      tenantCompanyId: TENANT.companyId,
      selectedId: "ch:chn_alpha",
    },
  });
  await vi.waitFor(() => {
    expect(rowFor(`dm:${HUMAN_UID}`)).toBeTruthy();
    expect(rowFor(`dm:${TALKATIVE_AGENT}`)).toBeTruthy();
  });
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

describe("ChatSidebar — archive and bot conversations compose", () => {
  it('keeps active bot conversations on the rail with "Show archived" on', async () => {
    await mountRail();
    for (const uid of BOT_UIDS) expect(rowFor(`dm:${uid}`)).toBeTruthy();

    await toggleShowArchived();

    expect(
      portalQuery("chat-filter-archived")!.getAttribute("aria-pressed"),
    ).toBe("true");
    for (const uid of BOT_UIDS) expect(rowFor(`dm:${uid}`)).toBeTruthy();
    expect(rowFor(`dm:${HUMAN_UID}`)).toBeTruthy();
    expect(rowFor(`dm:${TALKATIVE_AGENT}`)).toBeTruthy();
    expect(renderedIds().some((id) => id.startsWith("dm:agt_stub"))).toBe(true);
  });

  it('"Select all" reaches bot conversations, archived on or off', async () => {
    await mountRail();
    rowFor(`dm:${HUMAN_UID}`)!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    await tick();
    portalQuery<HTMLButtonElement>("chat-selection-all")!.click();
    await tick();

    const selected = () =>
      [
        ...host.querySelectorAll<HTMLElement>('.chat-row[aria-selected="true"]'),
      ].map((el) => el.dataset.conversationId!);
    expect(selected()).toContain(`dm:${HUMAN_UID}`);
    expect(selected().some((id) => id.startsWith("dm:agt_stub"))).toBe(true);
    expect(portalQuery("chat-selection-count")!.textContent).toContain(
      `${renderedIds().length} selected`,
    );

    await toggleShowArchived();
    portalQuery<HTMLButtonElement>("chat-selection-all")!.click();
    await tick();
    expect(selected().some((id) => id.startsWith("dm:agt_stub"))).toBe(true);
  });

  it("archives a bot row, counts it, and shows its pill", async () => {
    await mountRail();
    const visibleBefore = renderedIds().length;

    rowFor(`dm:${TALKATIVE_AGENT}`)!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    await tick();
    portalQuery<HTMLButtonElement>("chat-context-archive")!.click();
    await tick();

    expect(rowFor(`dm:${TALKATIVE_AGENT}`)).toBeNull();
    expect(renderedIds()).toHaveLength(visibleBefore - 1);

    await openFilter();
    expect(
      portalQuery("chat-filter-archived")!.querySelector(
        '[data-testid="chat-filter-archived-count"]',
      )!.textContent,
    ).toContain("1");

    portalQuery<HTMLButtonElement>("chat-filter-archived")!.click();
    await tick();

    expect(rowFor(`dm:${TALKATIVE_AGENT}`)).toBeTruthy();
    expect(
      rowFor(`dm:${TALKATIVE_AGENT}`)!.querySelector(
        '[data-testid="chat-row-archived-pill"]',
      ),
    ).toBeTruthy();
    for (const uid of BOT_UIDS) expect(rowFor(`dm:${uid}`)).toBeTruthy();
  });
});
