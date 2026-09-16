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

describe("DesktopApp New bot: the Cloud option", () => {
  /** Server turns, posted one at a time exactly as hq-pro does. */
  const TURNS = [
    {
      v: 1,
      type: "lifecycle_card",
      cardId: "card_create_agent_1",
      kind: "create_agent",
      companyUid: "cmp_acme",
      state: "open",
      title: "Create an agent",
      fields: [
        { id: "name", label: "Agent name", control: "text", required: true, value: "" },
        { id: "handle", label: "Handle", control: "text", required: true, value: "" },
      ],
      actions: [{ id: "next", label: "Next", style: "primary" }],
      viewer: viewerOwner,
    },
    {
      v: 1,
      type: "lifecycle_card",
      cardId: "card_create_agent_2",
      kind: "create_agent",
      companyUid: "cmp_acme",
      state: "open",
      title: "Create an agent",
      fields: [
        {
          id: "size",
          label: "Size",
          control: "radio",
          required: true,
          value: "basic",
          options: [{ id: "basic", label: "Basic" }],
        },
      ],
      actions: [{ id: "create", label: "Create agent", style: "primary" }],
      viewer: viewerOwner,
    },
  ];

  it("creates a cloud bot and lands in its channel, with no create_agent card on the way", async () => {
    let posted = [TURNS[0]!];
    const runCompanyTabAction = vi.fn(async () =>
      ok({ cardId: "card_create_agent_1", actionId: "add_agent", state: "open", channelId: "chn_acme" }),
    );
    const runCardAction = vi.fn(async (args: { cardId: string; actionId: string }) => {
      if (args.cardId === "card_create_agent_1") {
        posted = [...posted, TURNS[1]!];
        return ok({ cardId: args.cardId, actionId: args.actionId, state: "done" });
      }
      return ok({
        cardId: args.cardId,
        actionId: args.actionId,
        state: "done",
        agentChannelId: "chn_polar",
        agentUid: "agt_polar",
      });
    });
    const fetchChannel = vi.fn(async () =>
      ok({ messages: posted.map((card, i) => systemMessage(`evt_${i}`, card)), nextCursor: null }),
    );
    const getCompanyTab = vi.fn(async (_uid: string, tab: string) =>
      ok(tab === "team" ? teamTab(true) : { tab, companyUid: "cmp_acme", viewer: viewerOwner, sections: [] }),
    );

    const opened: string[] = [];
    const onOpen = (event: Event) => {
      opened.push(String((event as CustomEvent).detail?.channelId ?? ""));
    };
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpen);
    try {
      mountApp(
        adapter({ runCompanyTabAction, runCardAction, fetchChannel, getCompanyTab }),
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
      clickAnywhere('[data-testid="create-bot-next"]');
      await settle(10);

      // A company can host a bot, so the Cloud home option is offered.
      const cloud = document.querySelector<HTMLButtonElement>('[data-testid="chat-bot-where-cloud"]');
      expect(cloud, "the Cloud option renders").toBeTruthy();
      cloud!.click();
      await settle(10);
      clickAnywhere('[data-testid="chat-bot-create"]');

      // The server's own sequence runs, and the shell opens the bot's channel.
      await vi.waitFor(() => expect(opened).toContain("chn_polar"), {
        timeout: 10_000,
        interval: 50,
      });
      expect(runCompanyTabAction).toHaveBeenCalledWith(
        expect.objectContaining({ tab: "team", cardId: "team:spend", actionId: "add_agent" }),
      );
      expect(runCardAction).toHaveBeenCalledTimes(2);
      expect(runCardAction.mock.calls[0]![0]).toMatchObject({
        cardId: "card_create_agent_1",
        actionId: "next",
      });

      // Nothing was ever drawn: the card that collects these details is a
      // retired timeline kind, and nothing was focused on it either.
      await settle(12);
      expect(document.querySelector('[data-card-kind="create_agent"]')).toBeNull();
      expect(document.querySelector('[data-card-id="card_create_agent_1"]')).toBeNull();
      expect(document.body.textContent).not.toContain("Create an agent");
    } finally {
      window.removeEventListener(OPEN_CHANNEL_EVENT, onOpen);
    }
  }, 30_000);

  it("hides the Cloud option on a host with no company tab action", async () => {
    // Local bots exist here, so the New bot flow opens — but without the team
    // action there is no way to make a cloud bot, and the option stays hidden
    // rather than offering a button that cannot work.
    const local = adapter({ runCompanyTabAction: undefined });
    (local as { bots?: unknown }).bots = {
      list: async () => ok({ bots: [] }),
      create: async () => ok({}),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
    };
    mountApp(local, COMPANY_ROW, { companies: [ACME_WORKSPACE] });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="chat-new-message"]')).toBeTruthy(),
    );
    clickAnywhere('[data-testid="chat-new-message"]');
    await settle(10);
    clickAnywhere('[data-testid="chat-create-new-bot"]');
    await settle(10);
    clickAnywhere('[data-testid="create-bot-next"]');
    await settle(10);
    expect(document.querySelector('[data-testid="chat-bot-where-cloud"]')).toBeNull();
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
