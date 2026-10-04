// @vitest-environment happy-dom

/**
 * Lifecycle entry points in the shell: the #setup summary card's primary action
 * landing on the create_company card the server posts, the absence of the
 * retired company-header "Add bot" button and its create_agent card, and the
 * New bot flow's Cloud option — which creates a company-hosted bot by running
 * the server's own card sequence headlessly and landing in the bot's channel.
 *
 * The full-window New Bot takeover replaces that flow only for a company the
 * `agents.desktop-agent-creation` flag is on for. Every test above the
 * "New Bot takeover" block runs with no such company, which is the app's
 * state for every company without the flag.
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
      // The New Bot takeover's waiting screen reads the bot's status.
      getStatus: async () => ok({ setupState: { phase: "provisioning" } }),
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
    appShell: { logToFile: async () => ok(undefined) },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  takePendingChannelOpen();
  // The New Bot takeover tests read what the shell stored for a bot.
  window.localStorage?.clear?.();
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
      actions: [{ id: "continue", label: "Continue", style: "primary" }],
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
          id: "runtime",
          label: "Runtime",
          control: "radio",
          required: true,
          value: "codex",
          options: [
            { id: "codex", label: "Codex" },
            { id: "grok", label: "Grok" },
            { id: "claude", label: "Claude" },
          ],
        },
      ],
      actions: [{ id: "continue", label: "Continue", style: "primary" }],
      viewer: viewerOwner,
    },
    {
      v: 1,
      type: "lifecycle_card",
      cardId: "card_create_agent_3",
      kind: "create_agent",
      companyUid: "cmp_acme",
      state: "open",
      title: "Create an agent",
      fields: [
        { id: "runtime", label: "Runtime", control: "readonly", required: true, value: "codex" },
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

  it("creates a Claude subscription agent from the cloud flow and opens its authorization page", async () => {
    let posted = [TURNS[0]!];
    const runCompanyTabAction = vi.fn(async () =>
      ok({ cardId: "card_create_agent_1", actionId: "add_agent", state: "open", channelId: "chn_acme" }),
    );
    const runCardAction = vi.fn(async (args: { cardId: string; actionId: string; values?: Record<string, string> }) => {
      if (args.cardId === "card_create_agent_1") {
        posted = [...posted, TURNS[1]!];
        return ok({ cardId: args.cardId, actionId: args.actionId, state: "done" });
      }
      if (args.cardId === "card_create_agent_2") {
        const finalTurn = TURNS[2]!;
        posted = [
          ...posted,
          {
            ...finalTurn,
            fields: finalTurn.fields.map((field) =>
              field.id === "runtime" ? { ...field, value: args.values?.runtime ?? "codex" } : field,
            ),
          },
        ];
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
      // NEWEST first, the order the wire really delivers a page in
      // (crates/hq-desktop-core/src/messages.rs, `ChannelDetail`). `posted` is
      // kept in turn order, so the page is its reverse — as in production.
      ok({
        messages: posted.map((card, i) => systemMessage(`evt_${i}`, card)).reverse(),
        nextCursor: null,
      }),
    );
    const getCompanyTab = vi.fn(async (_uid: string, tab: string) =>
      ok(tab === "team" ? teamTab(true) : { tab, companyUid: "cmp_acme", viewer: viewerOwner, sections: [] }),
    );
    const hasFeature = vi.fn(async () => ok(true));
    const onopenurl = vi.fn();

    const opened: string[] = [];
    const onOpen = (event: Event) => {
      opened.push(String((event as CustomEvent).detail?.channelId ?? ""));
    };
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpen);
    try {
      mountApp(
        adapter({ runCompanyTabAction, runCardAction, fetchChannel, getCompanyTab }, { hasFeature }),
        COMPANY_ROW,
        { companies: [ACME_WORKSPACE], onopenurl },
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
      // The cloud bot is named HERE, in front of the person, because the card
      // that used to ask for its name is no longer rendered anywhere.
      clickAnywhere('[data-testid="create-bot-next"]');
      await settle(10);
      const nameField = document.querySelector<HTMLInputElement>('[data-testid="chat-bot-name"]');
      expect(nameField, "the cloud details step asks for a name").toBeTruthy();
      nameField!.value = "Polar";
      nameField!.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(10);
      expect(document.querySelector('[data-testid="cloud-bot-size-basic"]')?.parentElement?.textContent).toContain("$42.00/month");
      document.querySelector<HTMLInputElement>('[data-testid="cloud-bot-runtime-claude"]')!.click();
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
      expect(hasFeature).toHaveBeenCalledWith("agents.claude-provider");
      expect(runCardAction).toHaveBeenCalledTimes(3);
      // The name the person typed reaches the server as-is: no cloud bot is
      // ever created under a suggestion they never saw.
      expect(runCardAction.mock.calls[0]![0]).toMatchObject({
        cardId: "card_create_agent_1",
        actionId: "continue",
        values: { name: "Polar", handle: "polar" },
      });
      expect(runCardAction.mock.calls[1]![0]).toMatchObject({
        cardId: "card_create_agent_2",
        values: { runtime: "claude" },
      });
      expect(runCardAction.mock.calls[2]![0]).toMatchObject({
        cardId: "card_create_agent_3",
        actionId: "create",
        values: { size: "basic", authMode: "subscription" },
      });
      expect(runCardAction.mock.calls[2]![0].values).not.toHaveProperty("apiKey");
      expect(onopenurl).toHaveBeenCalledWith("https://hq.getindigo.ai/resolve/agents/agt_polar");

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

  it("saves the Title on the new bot's profile, and still does after a refused first try", async () => {
    // The create_agent sequence asks for name, handle, runtime and size —
    // never a title. So the title the person typed is written onto the agent
    // profile once the sequence hands back the bot's uid, exactly the way a
    // Local bot's title is.
    let posted = [TURNS[0]!];
    let refuseOnce = true;
    const runCompanyTabAction = vi.fn(async () =>
      ok({ cardId: "card_create_agent_1", actionId: "add_agent", state: "open", channelId: "chn_acme" }),
    );
    const runCardAction = vi.fn(async (args: { cardId: string; actionId: string; values?: Record<string, string> }) => {
      if (args.cardId === "card_create_agent_1") {
        if (refuseOnce) {
          refuseOnce = false;
          return ok({ cardId: args.cardId, actionId: args.actionId, state: "blocked" });
        }
        posted = [...posted, TURNS[1]!];
        return ok({ cardId: args.cardId, actionId: args.actionId, state: "done" });
      }
      if (args.cardId === "card_create_agent_2") {
        const finalTurn = TURNS[2]!;
        posted = [
          ...posted,
          {
            ...finalTurn,
            fields: finalTurn.fields.map((field) =>
              field.id === "runtime" ? { ...field, value: args.values?.runtime ?? "codex" } : field,
            ),
          },
        ];
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
      ok({
        messages: posted.map((card, i) => systemMessage(`evt_${i}`, card)).reverse(),
        nextCursor: null,
      }),
    );
    const getCompanyTab = vi.fn(async (_uid: string, tab: string) =>
      ok(tab === "team" ? teamTab(true) : { tab, companyUid: "cmp_acme", viewer: viewerOwner, sections: [] }),
    );
    const updateAgentProfile = vi.fn(async () => ok({}));

    const opened: string[] = [];
    const onOpen = (event: Event) => {
      opened.push(String((event as CustomEvent).detail?.channelId ?? ""));
    };
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpen);
    try {
      mountApp(
        adapter({ runCompanyTabAction, runCardAction, fetchChannel, getCompanyTab }, { updateAgentProfile }),
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
      document.querySelector<HTMLButtonElement>('[data-testid="chat-bot-where-cloud"]')!.click();
      await settle(10);
      clickAnywhere('[data-testid="create-bot-next"]');
      await settle(10);

      const nameField = document.querySelector<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
      nameField.value = "Polar";
      nameField.dispatchEvent(new Event("input", { bubbles: true }));
      const titleField = document.querySelector<HTMLInputElement>('[data-testid="chat-bot-title"]');
      expect(titleField, "the cloud details step asks for a title").toBeTruthy();
      titleField!.value = "Ad account analyst";
      titleField!.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(10);

      // First try: the server refuses. The modal stays open with the draft —
      // title included — so the person can simply try again.
      clickAnywhere('[data-testid="chat-bot-create"]');
      await vi.waitFor(
        () => expect(document.querySelector('[data-testid="chat-create-entry-error"]')).toBeTruthy(),
        { timeout: 10_000, interval: 50 },
      );
      expect(updateAgentProfile).not.toHaveBeenCalled();
      expect(
        document.querySelector<HTMLInputElement>('[data-testid="chat-bot-title"]')?.value,
      ).toBe("Ad account analyst");

      clickAnywhere('[data-testid="chat-bot-create"]');
      await vi.waitFor(() => expect(opened).toContain("chn_polar"), {
        timeout: 10_000,
        interval: 50,
      });
      await vi.waitFor(
        () => expect(updateAgentProfile).toHaveBeenCalledWith("agt_polar", { title: "Ad account analyst" }),
        { timeout: 10_000, interval: 50 },
      );
      // The title is never smuggled into a card the server never asked it for.
      for (const call of runCardAction.mock.calls) {
        expect(call[0]).not.toHaveProperty("values.title");
      }
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

/**
 * The full-window New Bot flow is for companies with the
 * `agents.desktop-agent-creation` flag. The shell reads the flag per company
 * (`identity.hasCompanyFeature`), and a company without it keeps the "+"
 * modal's own create, exactly as the "Cloud option" tests above describe it.
 */
describe("DesktopApp New bot takeover", () => {
  const NEW_BOT_FLAG = "agents.desktop-agent-creation";
  const NEW_CLOUD_BOTS_STORAGE_KEY = "hq.chat.newCloudBots.v1";
  const BOT_CONNECTION_CARDS_STORAGE_KEY = "hq.chat.botConnectionCards.v1";
  const BOT_HELLO_ASKED_STORAGE_KEY = "hq.chat.botHelloAskedAt.v1";

  const GLOBEX_WORKSPACE = {
    ...ACME_WORKSPACE,
    slug: "globex",
    displayName: "Globex",
    cloudUid: "cmp_globex",
  } as const;

  /** What production answers for `team:spend/add_agent` on a paid company. */
  const OPENED = {
    cardId: "team:spend",
    actionId: "add_agent",
    state: "open",
    channelId: "chn_acme",
    focusCardId: "create_agent",
  };

  /** The three turns of the server's create_agent card, as the "+" modal's create walks them. */
  function cardTurns(companyUid: string) {
    const turn = (cardId: string, fields: unknown[], actionId: string) => ({
      v: 1,
      type: "lifecycle_card",
      cardId,
      kind: "create_agent",
      companyUid,
      state: "open",
      title: "Create an agent",
      fields,
      actions: [{ id: actionId, label: "Continue", style: "primary" }],
      viewer: viewerOwner,
    });
    return [
      turn(
        "card_create_agent_1",
        [
          { id: "name", label: "Agent name", control: "text", required: true, value: "" },
          { id: "handle", label: "Handle", control: "text", required: true, value: "" },
        ],
        "continue",
      ),
      turn(
        "card_create_agent_2",
        [
          {
            id: "runtime",
            label: "Runtime",
            control: "radio",
            required: true,
            value: "codex",
            options: [
              { id: "codex", label: "Codex" },
              { id: "grok", label: "Grok" },
            ],
          },
        ],
        "continue",
      ),
      turn(
        "card_create_agent_3",
        [
          { id: "runtime", label: "Runtime", control: "readonly", required: true, value: "codex" },
          {
            id: "size",
            label: "Size",
            control: "radio",
            required: true,
            value: "basic",
            options: [{ id: "basic", label: "Basic" }],
          },
        ],
        "create",
      ),
    ];
  }

  /** A server that walks the card's turns and mints `agt_polar` in `chn_polar`. */
  function cardWalkServer(companyUid = "cmp_acme") {
    const turns = cardTurns(companyUid);
    let posted = [turns[0]!];
    const runCompanyTabAction = vi.fn(async () =>
      ok({ cardId: "card_create_agent_1", actionId: "add_agent", state: "open", channelId: "chn_acme" }),
    );
    const runCardAction = vi.fn(
      async (args: { cardId: string; actionId: string; values?: Record<string, string> }) => {
        if (args.cardId === "card_create_agent_1") {
          posted = [...posted, turns[1]!];
          return ok({ cardId: args.cardId, actionId: args.actionId, state: "done" });
        }
        if (args.cardId === "card_create_agent_2") {
          posted = [...posted, turns[2]!];
          return ok({ cardId: args.cardId, actionId: args.actionId, state: "done" });
        }
        return ok({
          cardId: args.cardId,
          actionId: args.actionId,
          state: "done",
          agentChannelId: "chn_polar",
          agentUid: "agt_polar",
        });
      },
    );
    const fetchChannel = vi.fn(async () =>
      ok({
        messages: posted.map((card, i) => systemMessage(`evt_${i}`, card)).reverse(),
        nextCursor: null,
      }),
    );
    const getCompanyTab = vi.fn(async (_uid: string, tab: string) =>
      ok(tab === "team" ? teamTab(true) : { tab, companyUid, viewer: viewerOwner, sections: [] }),
    );
    return { runCompanyTabAction, runCardAction, fetchChannel, getCompanyTab };
  }

  function stored(key: string): string {
    return window.localStorage.getItem(key) ?? "";
  }

  async function openNewBot(): Promise<void> {
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="chat-new-message"]')).toBeTruthy(),
    );
    clickAnywhere('[data-testid="chat-new-message"]');
    await settle(10);
    clickAnywhere('[data-testid="chat-create-new-bot"]');
    await settle(10);
  }

  /** The "+" modal's Cloud path: kind → home (Cloud) → details → Create. */
  async function createInModal(name: string): Promise<void> {
    clickAnywhere('[data-testid="create-bot-next"]');
    await settle(10);
    clickAnywhere('[data-testid="chat-bot-where-cloud"]');
    await settle(10);
    clickAnywhere('[data-testid="create-bot-next"]');
    await settle(10);
    const nameField = document.querySelector<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
    nameField.value = name;
    nameField.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(10);
    clickAnywhere('[data-testid="chat-bot-create"]');
  }

  /** The takeover: name → Continue → Create. */
  async function createInTakeover(name: string): Promise<void> {
    const input = document.querySelector<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(10);
    clickAnywhere('[data-testid="new-bot-continue-name"]');
    await settle(10);
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLButtonElement>('[data-testid="new-bot-create-submit"]')?.disabled,
      ).toBe(false),
    );
    clickAnywhere('[data-testid="new-bot-create-submit"]');
    await settle(10);
  }

  it("opens the dark takeover before a cloud create action can run", async () => {
    const runCompanyTabAction = vi.fn();
    const hasCompanyFeature = vi.fn(async () => true);
    mountApp(
      adapter({ runCompanyTabAction }, { hasCompanyFeature }),
      COMPANY_ROW,
      { companies: [ACME_WORKSPACE] },
    );
    await openNewBot();

    // The flag was read for the one company a cloud bot can be made in.
    expect(hasCompanyFeature).toHaveBeenCalledWith(NEW_BOT_FLAG, "cmp_acme");
    const takeover = document.querySelector<HTMLElement>('[data-testid="new-bot-takeover"]');
    expect(takeover?.getAttribute("role")).toBe("dialog");
    expect(takeover?.getAttribute("aria-modal")).toBe("true");
    expect(takeover?.style.getPropertyValue("--new-bot-wallpaper")).toContain("url(");
    expect(takeover?.querySelectorAll(".new-bot-takeover-card")).toHaveLength(1);
    expect(document.querySelector('[data-testid="create-bot-kind-step"]')).toBeNull();
    expect(runCompanyTabAction).not.toHaveBeenCalled();
  }, 30_000);

  it("a company without the flag gets the in-modal flow: no takeover", async () => {
    const hasCompanyFeature = vi.fn(async () => false);
    mountApp(
      adapter({ runCompanyTabAction: vi.fn() }, { hasCompanyFeature }),
      COMPANY_ROW,
      { companies: [ACME_WORKSPACE] },
    );
    await openNewBot();

    expect(hasCompanyFeature).toHaveBeenCalledWith(NEW_BOT_FLAG, "cmp_acme");
    expect(document.querySelector('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="create-bot-kind-step"]')).toBeTruthy();
  }, 30_000);

  it("a flag read that fails gets the in-modal flow: no takeover", async () => {
    const hasCompanyFeature = vi.fn(async (): Promise<boolean> => {
      throw new Error("offline");
    });
    mountApp(
      adapter({ runCompanyTabAction: vi.fn() }, { hasCompanyFeature }),
      COMPANY_ROW,
      { companies: [ACME_WORKSPACE] },
    );
    await openNewBot();

    expect(hasCompanyFeature).toHaveBeenCalled();
    expect(document.querySelector('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(document.querySelector('[data-testid="create-bot-kind-step"]')).toBeTruthy();
  }, 30_000);

  it("a host that cannot read company flags gets the in-modal flow: no takeover", async () => {
    // No `hasCompanyFeature` on the adapter at all.
    mountApp(adapter({ runCompanyTabAction: vi.fn() }), COMPANY_ROW, {
      companies: [ACME_WORKSPACE],
    });
    await openNewBot();
    expect(document.querySelector('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(document.querySelector('[data-testid="create-bot-kind-step"]')).toBeTruthy();
  }, 30_000);

  it("reads each company's flag once, however often the '+' modal is opened", async () => {
    const hasCompanyFeature = vi.fn(async (_flag: string, companyUid: string) => companyUid === "cmp_globex");
    mountApp(
      adapter({ runCompanyTabAction: vi.fn() }, { hasCompanyFeature }),
      COMPANY_ROW,
      { companies: [ACME_WORKSPACE, GLOBEX_WORKSPACE] },
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="chat-new-message"]')).toBeTruthy(),
    );
    await settle(10);
    for (let i = 0; i < 4; i += 1) {
      clickAnywhere('[data-testid="chat-new-message"]');
      await settle(10);
      expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeTruthy();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle(10);
      expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeNull();
    }
    const asked = hasCompanyFeature.mock.calls.map((call) => `${call[0]} ${call[1]}`).sort();
    expect(asked).toEqual([`${NEW_BOT_FLAG} cmp_acme`, `${NEW_BOT_FLAG} cmp_globex`]);
  }, 30_000);

  it("in a mixed account, the takeover creates only in the company with the flag", async () => {
    // Acme has no flag; Globex does. The takeover offers Globex alone, so it
    // has no company step and its create goes to Globex.
    const runCompanyTabAction = vi.fn(async () => ok({ ...OPENED, channelId: "chn_globex" }));
    const runCardAction = vi.fn(async () =>
      ok({ cardId: "create_agent", actionId: "create", state: "done", agentUid: "agt_nova" }),
    );
    const hasCompanyFeature = vi.fn(async (_flag: string, companyUid: string) => companyUid === "cmp_globex");
    mountApp(
      adapter({ runCompanyTabAction, runCardAction }, { hasCompanyFeature }),
      COMPANY_ROW,
      { companies: [ACME_WORKSPACE, GLOBEX_WORKSPACE] },
    );
    await openNewBot();
    expect(document.querySelector('[data-testid="new-bot-takeover"]')).toBeTruthy();

    await createInTakeover("Nova");
    await vi.waitFor(() => expect(runCardAction).toHaveBeenCalledOnce());
    expect(document.querySelector('[data-testid="new-bot-company-grid"]')).toBeNull();
    expect(runCompanyTabAction).toHaveBeenCalledWith(
      expect.objectContaining({ companyUid: "cmp_globex", actionId: "add_agent" }),
    );
  }, 30_000);

  it("the takeover's create sends surface, conversation and deferChannels in one action", async () => {
    const runCompanyTabAction = vi.fn(async () => ok(OPENED));
    const runCardAction = vi.fn(async (_args: { values?: Record<string, string> }) =>
      ok({ cardId: "create_agent", actionId: "create", state: "done", agentUid: "agt_nova" }),
    );
    mountApp(
      adapter({ runCompanyTabAction, runCardAction }, { hasCompanyFeature: async () => true }),
      COMPANY_ROW,
      { companies: [ACME_WORKSPACE] },
    );
    await openNewBot();
    await createInTakeover("Nova");

    await vi.waitFor(() => expect(runCardAction).toHaveBeenCalledOnce());
    expect(runCardAction.mock.calls[0]![0]).toMatchObject({
      channelId: "chn_acme",
      cardId: "create_agent",
      actionId: "create",
      values: {
        name: "Nova",
        surface: "desktop_new_bot",
        conversation: "dm",
        deferChannels: "true",
      },
    });
    // The bot is remembered as made in the new flow on this device.
    await vi.waitFor(() => expect(stored(NEW_CLOUD_BOTS_STORAGE_KEY)).toContain("agt_nova"));
    expect(stored(BOT_CONNECTION_CARDS_STORAGE_KEY)).toContain("agt_nova");
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="new-bot-waking-screen"]')?.textContent).toContain(
        "Waking up Nova",
      ),
    );
  }, 30_000);

  it("a bot made in the takeover is asked for its first message once it can chat", async () => {
    const runCompanyTabAction = vi.fn(async () => ok(OPENED));
    const runCardAction = vi.fn(async () =>
      ok({ cardId: "create_agent", actionId: "create", state: "done", agentUid: "agt_nova" }),
    );
    const sendDm = vi.fn(async (_uid: string, _body: string, _extras?: Record<string, unknown>) => ok({}));
    const fetchDmThread = vi.fn(async () => ok({ messages: [], nextCursor: null }));
    const value = adapter(
      { runCompanyTabAction, runCardAction, sendDm, fetchDmThread },
      { hasCompanyFeature: async () => true },
    );
    (value.agents as unknown as Record<string, unknown>).getStatus = async () =>
      ok({ setupState: { phase: "ready" } });
    mountApp(value, COMPANY_ROW, { companies: [ACME_WORKSPACE] });
    await openNewBot();
    await createInTakeover("Nova");

    await vi.waitFor(() => expect(sendDm).toHaveBeenCalled(), { timeout: 10_000, interval: 50 });
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(sendDm.mock.calls[0]![0]).toBe("agt_nova");
    expect(sendDm.mock.calls[0]![2]).toEqual({
      audience: "agent",
      idempotencyKey: "new-bot-hello-agt_nova",
    });
    // B-8: the time of the request is kept on this device, so the bot's first
    // message can be found later on a page that leaves the request out.
    const before = Date.now();
    await vi.waitFor(() => expect(stored(BOT_HELLO_ASKED_STORAGE_KEY)).toContain("agt_nova"));
    const kept = JSON.parse(stored(BOT_HELLO_ASKED_STORAGE_KEY)) as {
      accounts: Record<string, { asked: Record<string, number>; made: string[] }>;
    };
    // Kept for the account that is signed in, which is also recorded as the bot's maker here.
    expect(Object.keys(kept.accounts)).toHaveLength(1);
    const mine = Object.values(kept.accounts)[0]!;
    expect(mine.made).toEqual(["agt_nova"]);
    const asked = mine.asked.agt_nova!;
    expect(asked).toBeGreaterThan(before - 60_000);
    expect(asked).toBeLessThanOrEqual(Date.now());
  }, 30_000);

  it("a bot found after a create with no answer is registered like one that answered: connection record and first message (round 4, item 2)", async () => {
    // The create's answer is lost, but the request made the bot. The sidebar
    // finds it on the company's list and takes it up. The shell never saw an
    // ok answer for it, and must still treat it as a bot made in this flow.
    const runCompanyTabAction = vi.fn(async () => ok(OPENED));
    const runCardAction = vi.fn(async (): Promise<never> => {
      throw new Error("The request timed out.");
    });
    const sendDm = vi.fn(async (_uid: string, _body: string, _extras?: Record<string, unknown>) => ok({}));
    const fetchDmThread = vi.fn(async () => ok({ messages: [], nextCursor: null }));
    const value = adapter(
      { runCompanyTabAction, runCardAction, sendDm, fetchDmThread },
      { hasCompanyFeature: async () => true },
    );
    const agents = value.agents as unknown as Record<string, unknown>;
    agents.getStatus = async () => ok({ setupState: { phase: "ready" } });
    // The list read at the press has no Nova. Once the create was sent, it does.
    const listMobileRoster = vi.fn(async (companyUid: string) =>
      ok({
        agents: runCardAction.mock.calls.length
          ? [{ agentUid: "agt_nova", uid: "agt_nova", companyUid, name: "nova", displayName: "Nova", slug: "nova", setupPhase: "provisioning" }]
          : [],
      }),
    );
    agents.listMobileRoster = listMobileRoster;
    mountApp(value, COMPANY_ROW, { companies: [ACME_WORKSPACE] });
    await openNewBot();
    await createInTakeover("Nova");

    // One look, ten seconds after the lost answer.
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalled(), { timeout: 25_000, interval: 100 });
    expect(runCardAction).toHaveBeenCalledTimes(1);
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(sendDm.mock.calls[0]![0]).toBe("agt_nova");
    expect(sendDm.mock.calls[0]![2]).toEqual({
      audience: "agent",
      idempotencyKey: "new-bot-hello-agt_nova",
    });
    expect(stored(NEW_CLOUD_BOTS_STORAGE_KEY)).toContain("agt_nova");
    expect(stored(BOT_CONNECTION_CARDS_STORAGE_KEY)).toContain("agt_nova");
  }, 45_000);

  it("the in-modal create sends none of surface, conversation or deferChannels, and opens the new bot's channel", async () => {
    const server = cardWalkServer();
    const sendDm = vi.fn(async () => ok({}));
    const fetchDmThread = vi.fn(async () => ok({ messages: [], nextCursor: null }));
    const hasCompanyFeature = vi.fn(async () => false);

    const opened: string[] = [];
    const onOpen = (event: Event) => {
      opened.push(String((event as CustomEvent).detail?.channelId ?? ""));
    };
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpen);
    try {
      mountApp(
        adapter({ ...server, sendDm, fetchDmThread }, { hasCompanyFeature }),
        COMPANY_ROW,
        { companies: [ACME_WORKSPACE] },
      );
      await openNewBot();
      expect(document.querySelector('[data-testid="new-bot-takeover"]')).toBeNull();
      await createInModal("Polar");

      // The shell opens the bot's channel, as it does on main.
      await vi.waitFor(() => expect(opened).toContain("chn_polar"), {
        timeout: 10_000,
        interval: 50,
      });
      // The card is walked turn by turn. No turn carries the takeover's values.
      expect(server.runCardAction).toHaveBeenCalledTimes(3);
      for (const call of server.runCardAction.mock.calls) {
        const values = call[0].values ?? {};
        expect(values).not.toHaveProperty("surface");
        expect(values).not.toHaveProperty("conversation");
        expect(values).not.toHaveProperty("deferChannels");
      }
      expect(server.runCardAction.mock.calls[0]![0]).toMatchObject({
        cardId: "card_create_agent_1",
        actionId: "continue",
        values: { name: "Polar", handle: "polar" },
      });
      expect(server.runCardAction.mock.calls[2]![0]).toMatchObject({
        cardId: "card_create_agent_3",
        actionId: "create",
        values: { size: "basic", authMode: "subscription" },
      });
      // The modal closed and no takeover or waiting screen took its place.
      expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeNull();
      expect(document.querySelector('[data-testid="new-bot-takeover"]')).toBeNull();
      expect(document.querySelector('[data-testid="new-bot-waking-screen"]')).toBeNull();
    } finally {
      window.removeEventListener(OPEN_CHANNEL_EVENT, onOpen);
    }
  }, 30_000);

  it("a bot made in the modal gets no hello request and is not kept as a new-flow bot", async () => {
    const server = cardWalkServer();
    const sendDm = vi.fn(async () => ok({}));
    const fetchDmThread = vi.fn(async () => ok({ messages: [], nextCursor: null }));
    const getStatus = vi.fn(async () => ok({ setupState: { phase: "ready" } }));

    const opened: string[] = [];
    const onOpen = (event: Event) => {
      opened.push(String((event as CustomEvent).detail?.channelId ?? ""));
    };
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpen);
    try {
      const value = adapter(
        { ...server, sendDm, fetchDmThread },
        { hasCompanyFeature: async () => false },
      );
      (value.agents as unknown as Record<string, unknown>).getStatus = getStatus;
      mountApp(value, COMPANY_ROW, { companies: [ACME_WORKSPACE] });
      await openNewBot();
      await createInModal("Polar");
      await vi.waitFor(() => expect(opened).toContain("chn_polar"), {
        timeout: 10_000,
        interval: 50,
      });
      await settle(20);

      // No first-message request on the bot-only lane, and no check for one.
      expect(sendDm).not.toHaveBeenCalled();
      expect(fetchDmThread).not.toHaveBeenCalled();
      // Not a new-flow bot on this device: no sync-strip first download, no
      // connection cards, no waking row, no hidden setup channel.
      expect(stored(NEW_CLOUD_BOTS_STORAGE_KEY)).not.toContain("agt_polar");
      expect(stored(BOT_CONNECTION_CARDS_STORAGE_KEY)).not.toContain("agt_polar");
      expect(stored("hq.chat.botSetupChannels.v1")).not.toContain("chn_polar");
      expect(document.querySelector('[data-testid="chat-waking-bot-ring"]')).toBeNull();
      expect(document.querySelector('[data-conversation-id="dm:agt_polar"]')).toBeNull();
    } finally {
      window.removeEventListener(OPEN_CHANNEL_EVENT, onOpen);
    }
  }, 30_000);

  it("in a flagged company, 'create a local bot instead' then Cloud still uses the in-modal create", async () => {
    const server = cardWalkServer();
    const sendDm = vi.fn(async () => ok({}));
    const local = adapter({ ...server, sendDm }, { hasCompanyFeature: async () => true });
    (local as { bots?: unknown }).bots = {
      list: async () => ok({ bots: [] }),
      create: async () => ok({}),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
    };

    const opened: string[] = [];
    const onOpen = (event: Event) => {
      opened.push(String((event as CustomEvent).detail?.channelId ?? ""));
    };
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpen);
    try {
      mountApp(local, COMPANY_ROW, { companies: [ACME_WORKSPACE] });
      await openNewBot();
      expect(document.querySelector('[data-testid="new-bot-takeover"]')).toBeTruthy();
      clickAnywhere('[data-testid="new-bot-takeover-local"]');
      await settle(10);
      expect(document.querySelector('[data-testid="new-bot-takeover"]')).toBeNull();
      expect(document.querySelector('[data-testid="create-bot-kind-step"]')).toBeTruthy();

      await createInModal("Polar");
      await vi.waitFor(() => expect(opened).toContain("chn_polar"), {
        timeout: 10_000,
        interval: 50,
      });
      expect(server.runCardAction).toHaveBeenCalledTimes(3);
      for (const call of server.runCardAction.mock.calls) {
        const values = call[0].values ?? {};
        expect(values).not.toHaveProperty("surface");
        expect(values).not.toHaveProperty("conversation");
        expect(values).not.toHaveProperty("deferChannels");
      }
      await settle(20);
      expect(sendDm).not.toHaveBeenCalled();
      expect(stored(NEW_CLOUD_BOTS_STORAGE_KEY)).not.toContain("agt_polar");
    } finally {
      window.removeEventListener(OPEN_CHANNEL_EVENT, onOpen);
    }
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
