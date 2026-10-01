// @vitest-environment happy-dom

/**
 * Lifecycle entry points in the shell: the #setup summary card's primary action
 * landing on the create_company card the server posts, the absence of the
 * retired company-header "Add bot" button and its create_agent card, and the
 * New bot flow's Cloud option — which creates a company-hosted bot by running
 * the server's own card sequence headlessly and landing in the bot's channel.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView, type PlatformAdapter } from "@hq/platform";

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
  isCompanyHome: true,
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

const CLOUD_PROVISION_OPTIONS: AgentProvisionOptionsView = {
  defaultInstanceType: "t4g.medium",
  catalogVersion: "test-catalog",
  options: [
    {
      key: "basic",
      productName: "Basic",
      instanceType: "t4g.medium",
      listCents: 5000,
      default: true,
      selectable: true,
      netMonthlyCents: 4200,
      deltaCents: 4200,
      unavailableReason: null,
      notBilled: false,
      lanes: 1,
      workers: 1,
    },
  ],
};

/** One cloud company, so the New bot flow has somewhere to host a bot. */
const ACME_WORKSPACE = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_acme",
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
} as const;

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
  identity: Record<string, unknown> = {},
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
    identity: {
      listAvatarPacks: async () => ok({ packs: [], expiresAt: Date.now() + 60_000 }),
      updateAgentProfile: async () => ok({}),
      hasFeature: async () => ok(false),
      ...identity,
    },
    agents: {
      getProvisionOptions: async () => ok(CLOUD_PROVISION_OPTIONS),
    },
    meetings: {
      listUpcoming: async () => ok([]),
    },
    calls: {
      contractVersion: "hq-meet/1",
      discoverOffice: async (companyUid: string) => ok({ companyUid, people: [], observedAt: Date.now() }),
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

function mountApp(
  adapterValue: PlatformAdapter,
  initialRow: ConversationRow,
  extra: Record<string, unknown> = {},
): void {
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
      ...extra,
    },
  });
}

function clickAnywhere(selector: string): void {
  const el = document.querySelector<HTMLButtonElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.click();
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

describe("DesktopApp New bot takeover", () => {
  it("opens the dark takeover before a cloud create action can run", async () => {
    const runCompanyTabAction = vi.fn();
    mountApp(
      adapter({ runCompanyTabAction }),
      COMPANY_ROW,
      { companies: [ACME_WORKSPACE] },
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="chat-new-message"]')).toBeTruthy(),
    );

    clickAnywhere('[data-testid="chat-new-message"]');
    await settle(10);
    clickAnywhere('[data-testid="chat-create-new-bot"]');
    await settle(10);

    const takeover = document.querySelector<HTMLElement>('[data-testid="new-bot-takeover"]');
    expect(takeover?.getAttribute("role")).toBe("dialog");
    expect(takeover?.getAttribute("aria-modal")).toBe("true");
    expect(takeover?.style.getPropertyValue("--new-bot-wallpaper")).toContain("url(");
    expect(takeover?.querySelectorAll(".new-bot-takeover-card")).toHaveLength(1);
    expect(document.querySelector('[data-testid="create-bot-kind-step"]')).toBeNull();
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
