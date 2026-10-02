// @vitest-environment happy-dom

/**
 * desktop-agent-creation US-004 in the shell: with `agents.desktop-agent-creation`
 * on for the company, New bot → Cloud is one POST /v1/agents and the bot's DM
 * opens; with it off, the card sequence runs exactly as before.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { takePendingChannelOpen } from "../chat/open-target.js";
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


const FLAG = "agents.desktop-agent-creation";

interface Sent {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** hq-pro over `agents.fetch`: provision-options and POST /v1/agents. */
function agentsFetch(createAnswer: { status: number; body: unknown }) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (path: string, init: { method: string; body?: string }) => {
    sent.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (path.startsWith("/v1/agents/provision-options")) {
      return { status: 200, text: async () => JSON.stringify(CLOUD_PROVISION_OPTIONS) };
    }
    if (path === "/v1/agents" && init.method === "POST") {
      return { status: createAnswer.status, text: async () => JSON.stringify(createAnswer.body) };
    }
    return { status: 404, text: async () => "{}" };
  });
  return { fetch, sent };
}

function flaggedAdapter(
  flagOn: boolean,
  fetch: ReturnType<typeof agentsFetch>["fetch"],
  messaging: Partial<PlatformAdapter["messaging"]>,
  updateAgentProfile = vi.fn(async () => ok({})),
): PlatformAdapter {
  const base = adapter(messaging, {
    updateAgentProfile,
    hasFeature: vi.fn(async (flag: string, scope?: { companyUid?: string | null }) =>
      ok(flag === FLAG ? flagOn && scope?.companyUid === "cmp_acme" : true),
    ),
  });
  return {
    ...base,
    agents: { ...base.agents, fetch },
  } as unknown as PlatformAdapter;
}

async function createPolar(): Promise<void> {
  await vi.waitFor(() => expect(document.querySelector('[data-testid="chat-new-message"]')).toBeTruthy());
  clickAnywhere('[data-testid="chat-new-message"]');
  await settle(10);
  clickAnywhere('[data-testid="chat-create-new-bot"]');
  await settle(10);
  clickAnywhere('[data-testid="create-bot-next"]');
  await settle(10);
  clickAnywhere('[data-testid="chat-bot-where-cloud"]');
  await settle(10);
  clickAnywhere('[data-testid="create-bot-next"]');
  await settle(10);
  const nameField = document.querySelector<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
  nameField.value = "Polar";
  nameField.dispatchEvent(new Event("input", { bubbles: true }));
  const titleField = document.querySelector<HTMLInputElement>('[data-testid="chat-bot-title"]')!;
  titleField.value = "Ad analyst";
  titleField.dispatchEvent(new Event("input", { bubbles: true }));
  await settle(10);
  document.querySelector<HTMLInputElement>('[data-testid="cloud-bot-runtime-grok"]')!.click();
  await settle(10);
  clickAnywhere('[data-testid="chat-bot-create"]');
}

const CREATED = {
  agent: { uid: "agt_polar", name: "Polar", slug: "polar", companyUid: "cmp_acme" },
  setupState: { version: 1, phase: "provisioning", idempotencyKey: "k", steps: [], updatedAt: "t" },
};

describe("DesktopApp New bot → Cloud, agents.desktop-agent-creation", () => {
  it("flag on: one POST /v1/agents, no card sequence, the title saved, the DM opened", async () => {
    const { fetch, sent } = agentsFetch({ status: 201, body: CREATED });
    const runCompanyTabAction = vi.fn();
    const runCardAction = vi.fn();
    const updateAgentProfile = vi.fn(async () => ok({}));
    const fetchDmThread = vi.fn(async () => ok({ messages: [], nextCursor: null }));
    mountApp(
      flaggedAdapter(true, fetch, { runCompanyTabAction, runCardAction, fetchDmThread }, updateAgentProfile),
      COMPANY_ROW,
      { companies: [ACME_WORKSPACE] },
    );
    await createPolar();

    await vi.waitFor(() => expect(sent.some((s) => s.path === "/v1/agents")).toBe(true), { timeout: 10_000, interval: 50 });
    const create = sent.find((s) => s.path === "/v1/agents")!;
    expect(create.method).toBe("POST");
    expect(create.body).toMatchObject({
      companyUid: "cmp_acme",
      name: "Polar",
      slug: "polar",
      provider: "agents-v2",
      codexModel: "grok-4.7",
      codexAuthMode: "subscription",
      deferChannels: true,
      surface: "desktop_new_bot",
      desiredInstanceType: "t4g.medium",
      quotedNetMonthlyCents: 4200,
      quoteCatalogVersion: "test-catalog",
    });
    expect(String(create.body?.idempotencyKey)).toMatch(/^desktop-new-bot-/);
    expect(create.body).not.toHaveProperty("codexApiKey");
    expect(runCompanyTabAction).not.toHaveBeenCalled();
    expect(runCardAction).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeNull());
    await vi.waitFor(() => expect(updateAgentProfile).toHaveBeenCalledWith("agt_polar", { title: "Ad analyst" }));
    // The new bot's DM is the open conversation.
    await vi.waitFor(() =>
      expect(fetchDmThread).toHaveBeenCalledWith(expect.objectContaining({ withPersonUid: "agt_polar" })),
    );
  }, 30_000);

  it("flag on: a plan refusal keeps the flow open with the plan and the checkout link", async () => {
    const { fetch } = agentsFetch({
      status: 403,
      body: {
        code: "AGENT_PLAN_LIMIT",
        error: "Your plan does not include agents.",
        requiredPlan: "agents-500",
        amountMinor: 50000,
        currency: "usd",
        checkoutUrl: "https://checkout.test/agents",
      },
    });
    const fetchDmThread = vi.fn(async () => ok({ messages: [], nextCursor: null }));
    mountApp(flaggedAdapter(true, fetch, { runCompanyTabAction: vi.fn(), runCardAction: vi.fn(), fetchDmThread }), COMPANY_ROW, {
      companies: [ACME_WORKSPACE],
    });
    await createPolar();
    await vi.waitFor(
      () =>
        expect(document.querySelector('[data-testid="chat-create-entry-error"]')?.textContent).toContain(
          "Cloud bots need the Agents plan ($500 a month). Acme isn't on it yet.",
        ),
      { timeout: 10_000, interval: 50 },
    );
    expect(document.querySelector('[data-testid="chat-create-entry-fix"]')?.getAttribute("href")).toBe(
      "https://checkout.test/agents",
    );
    expect(document.querySelector('[data-testid="chat-create-modal"]')).toBeTruthy();
    expect(fetchDmThread).not.toHaveBeenCalled();
  }, 30_000);

  it("flag off: the card sequence runs and nothing is POSTed to /v1/agents", async () => {
    const { fetch, sent } = agentsFetch({ status: 201, body: CREATED });
    const runCompanyTabAction = vi.fn(async () => ok({ cardId: "", actionId: "add_agent", state: "blocked", channelId: "chn_acme", reason: "nope" }));
    const fetchChannel = vi.fn(async () => ok({ messages: [], nextCursor: null }));
    mountApp(
      flaggedAdapter(false, fetch, { runCompanyTabAction, runCardAction: vi.fn(), fetchChannel }),
      COMPANY_ROW,
      { companies: [ACME_WORKSPACE] },
    );
    await createPolar();
    await vi.waitFor(() => expect(runCompanyTabAction).toHaveBeenCalled(), { timeout: 10_000, interval: 50 });
    await settle(12);
    expect(sent.some((s) => s.path === "/v1/agents")).toBe(false);
    expect(sent.some((s) => s.path.startsWith("/v1/agents/provision-options"))).toBe(false);
  }, 30_000);
});
