// @vitest-environment happy-dom

/**
 * Lifecycle entry points in the shell: the company header "Add agent" ghost
 * button (present only when the Team tab viewer can act), the navigation after
 * `team:spend/add_agent`, and the #setup summary card's primary action landing
 * on the create_company card the server posts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { OPEN_CHANNEL_EVENT, takePendingChannelOpen } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

const COMPANY_ROW: ConversationRow = {
  id: "ch:chn_acme",
  kind: "channel",
  title: "acme",
  channelId: "chn_acme",
  channelScope: "company",
  companyUid: "cmp_acme",
} as ConversationRow;

const SETUP_ROW: ConversationRow = {
  id: "ch:setup",
  kind: "channel",
  title: "setup",
  channelId: "setup",
  channelScope: "personal",
  companyUid: null,
} as ConversationRow;

const viewerOwner = { canAct: true, role: "owner" };

function teamTab(canAct: boolean) {
  return {
    tab: "team",
    companyUid: "cmp_acme",
    viewer: { canAct, role: canAct ? "owner" : "member" },
    sections: [
      {
        id: "agents",
        title: "Agents",
        rows: [
          {
            v: 1,
            type: "lifecycle_card",
            cardId: "team:spend",
            kind: "tab_row",
            companyUid: "cmp_acme",
            state: "open",
            viewer: { canAct, role: canAct ? "owner" : "member" },
            fields: [{ id: "total", label: "Agent spend", control: "readonly", value: "$0/mo" }],
            actions: canAct ? [{ id: "add_agent", label: "Add agent", style: "primary" }] : [],
          },
        ],
      },
    ],
  };
}

function systemMessage(eventId: string, card: Record<string, unknown>) {
  return {
    eventId,
    fromDisplayName: "HQ",
    body: String(card.title ?? "Lifecycle update"),
    createdAt: "2026-09-04T12:00:00.000Z",
    direction: "in",
    messageKind: "system",
    systemEvent: card,
  };
}

const CREATE_AGENT_CARD = {
  v: 1,
  type: "lifecycle_card",
  cardId: "card_create_agent_1",
  kind: "create_agent",
  companyUid: "cmp_acme",
  state: "open",
  title: "Create an agent",
  fields: [{ id: "name", label: "Agent name", control: "text", required: true, value: "" }],
  actions: [{ id: "next", label: "Next", style: "primary" }],
  viewer: viewerOwner,
};

const SUMMARY_CARD = {
  v: 1,
  type: "lifecycle_card",
  cardId: "companies_summary",
  kind: "companies_summary",
  companyUid: null,
  state: "open",
  title: "Your companies",
  fields: [{ id: "acme", label: "Acme", control: "readonly", value: "Workforce" }],
  actions: [{ id: "create_company", label: "Create another company", style: "primary" }],
  viewer: viewerOwner,
};

const SECOND_CREATE_CARD = {
  v: 1,
  type: "lifecycle_card",
  cardId: "card_create_company_2",
  kind: "create_company",
  companyUid: null,
  state: "open",
  title: "Name your company",
  fields: [{ id: "name", label: "Company name", control: "text", required: true, value: "" }],
  actions: [{ id: "submit", label: "Create company", style: "primary" }],
  viewer: viewerOwner,
};

function adapter(
  messaging: Partial<PlatformAdapter["messaging"]> = {},
): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      runCardAction: async () => ({ ok: false as const, reason: "unavailable" }),
      ...messaging,
    },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  takePendingChannelOpen();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function mountApp(adapterValue: PlatformAdapter, initialRow: ConversationRow): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapterValue,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Stefan Johnson", email: "stefan@example.com" },
      coreFixtures: false,
      initialRow,
    },
  });
}

describe("DesktopApp company header: Add agent", () => {
  it("shows the 28px ghost button when the Team tab viewer can act and lands on the posted card", async () => {
    const getCompanyTab = vi.fn(async (_uid: string, tab: string) =>
      ok(tab === "team" ? teamTab(true) : { tab, companyUid: "cmp_acme", viewer: viewerOwner, sections: [] }),
    );
    const runCompanyTabAction = vi.fn(async () =>
      ok({
        cardId: "card_create_agent_1",
        actionId: "add_agent",
        state: "open",
        replayed: false,
        channelId: "chn_acme",
      }),
    );
    const fetchChannel = vi.fn(async () =>
      ok({ messages: [systemMessage("evt_agent", CREATE_AGENT_CARD)], nextCursor: null }),
    );
    const opened: string[] = [];
    const onOpen = (event: Event) =>
      opened.push(String((event as CustomEvent).detail?.channelId ?? ""));
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpen);

    mountApp(adapter({ getCompanyTab, runCompanyTabAction, fetchChannel }), COMPANY_ROW);
    await vi.waitFor(
      () => {
        expect(host.querySelector('[data-testid="company-add-agent"]')).toBeTruthy();
      },
      { timeout: 10_000, interval: 50 },
    );
    const button = host.querySelector<HTMLButtonElement>('[data-testid="company-add-agent"]')!;
    expect(button.textContent?.trim()).toBe("Add agent");
    expect(button.getAttribute("aria-label")).toMatch(/^Add an agent to /);
    expect(button.classList.contains("header-ghost-btn")).toBe(true);
    // Sits in the header row next to the company tabs.
    expect(
      button.parentElement?.querySelector('[data-testid="company-channel-tabs"]'),
    ).toBeTruthy();

    button.click();
    await settle(12);
    expect(runCompanyTabAction).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUid: "cmp_acme",
        tab: "team",
        cardId: "team:spend",
        actionId: "add_agent",
      }),
    );
    // Already on the company channel: no re-open, just scroll + focus the card.
    expect(opened).toEqual([]);
    await vi.waitFor(
      () => {
        expect(document.activeElement?.getAttribute("data-card-id")).toBe(
          "card_create_agent_1",
        );
      },
      { timeout: 10_000, interval: 50 },
    );
    window.removeEventListener(OPEN_CHANNEL_EVENT, onOpen);
  }, 30_000);

  it("re-opens the channel the server names when it differs from the current one", async () => {
    const getCompanyTab = vi.fn(async (_uid: string, tab: string) =>
      ok(tab === "team" ? teamTab(true) : { tab, companyUid: "cmp_acme", viewer: viewerOwner, sections: [] }),
    );
    const runCompanyTabAction = vi.fn(async () =>
      ok({ cardId: "card_upgrade_plan_2", actionId: "add_agent", state: "open", channelId: "chn_acme_general" }),
    );
    const opened: Array<Record<string, unknown>> = [];
    const onOpen = (event: Event) => opened.push((event as CustomEvent).detail ?? {});
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpen);
    mountApp(adapter({ getCompanyTab, runCompanyTabAction }), COMPANY_ROW);
    await vi.waitFor(
      () => expect(host.querySelector('[data-testid="company-add-agent"]')).toBeTruthy(),
      { timeout: 10_000, interval: 50 },
    );
    host.querySelector<HTMLButtonElement>('[data-testid="company-add-agent"]')!.click();
    await settle(12);
    window.removeEventListener(OPEN_CHANNEL_EVENT, onOpen);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      channelId: "chn_acme_general",
      companyUid: "cmp_acme",
      focusCardId: "card_upgrade_plan_2",
    });
  }, 30_000);

  it("hides the button when the Team tab viewer cannot act", async () => {
    const getCompanyTab = vi.fn(async (_uid: string, tab: string) =>
      ok(tab === "team" ? teamTab(false) : { tab, companyUid: "cmp_acme", viewer: { canAct: false }, sections: [] }),
    );
    mountApp(adapter({ getCompanyTab, runCompanyTabAction: vi.fn() }), COMPANY_ROW);
    await vi.waitFor(
      () => expect(getCompanyTab).toHaveBeenCalledWith("cmp_acme", "team"),
      { timeout: 10_000, interval: 50 },
    );
    await settle(12);
    expect(host.querySelector('[data-testid="company-channel-tabs"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="company-add-agent"]')).toBeNull();
  }, 30_000);

  it("shows a blocked permission reason inline next to the button", async () => {
    const getCompanyTab = vi.fn(async (_uid: string, tab: string) =>
      ok(tab === "team" ? teamTab(true) : { tab, companyUid: "cmp_acme", viewer: viewerOwner, sections: [] }),
    );
    const runCompanyTabAction = vi.fn(async () =>
      ok({ cardId: "team:spend", actionId: "add_agent", state: "blocked", reason: "Only owners can add agents." }),
    );
    mountApp(adapter({ getCompanyTab, runCompanyTabAction }), COMPANY_ROW);
    await vi.waitFor(
      () => expect(host.querySelector('[data-testid="company-add-agent"]')).toBeTruthy(),
      { timeout: 10_000, interval: 50 },
    );
    host.querySelector<HTMLButtonElement>('[data-testid="company-add-agent"]')!.click();
    await settle(12);
    const error = host.querySelector('[data-testid="company-add-agent-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain("Only owners can add agents.");
  }, 30_000);
});

describe("DesktopApp #setup companies summary", () => {
  it("renders the primary action and lands on the create_company card the server posts", async () => {
    const runCardAction = vi.fn(async () =>
      ok({ cardId: "card_create_company_2", actionId: "create_company", state: "open", channelId: "setup" }),
    );
    const fetchChannel = vi.fn(async () =>
      ok({
        messages: [
          systemMessage("evt_second", SECOND_CREATE_CARD),
          systemMessage("evt_summary", SUMMARY_CARD),
        ],
        nextCursor: null,
      }),
    );
    mountApp(adapter({ runCardAction, fetchChannel }), SETUP_ROW);
    await vi.waitFor(
      () => {
        expect(host.querySelector('[data-testid="lifecycle-action-create_company"]')).toBeTruthy();
      },
      { timeout: 15_000, interval: 50 },
    );
    const summary = host.querySelector('[data-card-kind="companies_summary"]');
    expect(summary?.querySelector('[data-testid="lifecycle-action-create_company"]')?.textContent?.trim()).toBe(
      "Create another company",
    );
    host.querySelector<HTMLButtonElement>('[data-testid="lifecycle-action-create_company"]')!.click();
    await settle(12);
    expect(runCardAction).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "setup", cardId: "companies_summary", actionId: "create_company" }),
    );
    await vi.waitFor(
      () => {
        expect(document.activeElement?.getAttribute("data-card-id")).toBe("card_create_company_2");
      },
      { timeout: 10_000, interval: 50 },
    );
  }, 30_000);
});
