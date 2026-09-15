// @vitest-environment happy-dom

/**
 * Lifecycle entry points in the shell: the #setup summary card's primary action
 * landing on the create_company card the server posts, and the absence of the
 * retired company-header "Add bot" button and its create_agent card.
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

describe("DesktopApp company header: no server bot form", () => {
  it("has no Add bot button and never renders a create_agent card in the company channel", async () => {
    // Bots come from the local bot flow (bot kinds). The Team tab action that
    // posted the server's "Create a bot" card is gone, and a card already
    // sitting in the channel's history is not shown.
    const getCompanyTab = vi.fn(async (_uid: string, tab: string) =>
      ok(tab === "team" ? teamTab(true) : { tab, companyUid: "cmp_acme", viewer: viewerOwner, sections: [] }),
    );
    const runCompanyTabAction = vi.fn();
    const fetchChannel = vi.fn(async () =>
      ok({ messages: [systemMessage("evt_agent", CREATE_AGENT_CARD)], nextCursor: null }),
    );

    mountApp(
      adapter({ getCompanyTab, runCompanyTabAction, fetchChannel }),
      COMPANY_ROW,
    );
    await vi.waitFor(
      () => expect(host.querySelector('[data-testid="company-console-gear"]')).toBeTruthy(),
      { timeout: 10_000, interval: 50 },
    );
    await settle(12);

    expect(host.querySelector('[data-testid="company-add-agent"]')).toBeNull();
    expect(
      host.querySelector('[data-card-id="card_create_agent_1"]'),
    ).toBeNull();
    expect(host.textContent).not.toContain("Create an agent");
    expect(runCompanyTabAction).not.toHaveBeenCalled();
  }, 30_000);
});

describe("DesktopApp #setup companies summary", () => {
  it("never renders the summary card on #welcome; a server-posted create_company card still lands", async () => {
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
        expect(host.querySelector('[data-card-id="card_create_company_2"]')).toBeTruthy();
      },
      { timeout: 15_000, interval: 50 },
    );
    // #welcome has one job (Run Setup). The companies summary duplicated the
    // sidebar and the company channel as a chat message; it is filtered out.
    // "Create another company" lives under the hero's Advanced disclosure and
    // still runs the same server action (covered in DesktopApp.setup-channel).
    expect(host.querySelector('[data-card-kind="companies_summary"]')).toBeNull();
    expect(host.textContent).not.toContain("Your companies");
  }, 30_000);
});
