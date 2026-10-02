// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView, type LocalBotRow, type PlatformAdapter } from "@hq/platform";
import type { DirectCloudCreate } from "../chat/create-bot/cloud-create.js";

import BotsSettingsPane from "./BotsSettingsPane.svelte";
import { cloudBotsFromRoster } from "./cloud-bots.js";

const CLOUD_UID = "agt_374A1JY3NE63KSYBN97PND4QGC";
const OTHER_UID = "agt_0000000000000000000000OTHR";

const LOCAL_BOT: LocalBotRow = {
  name: "assistant",
  agentUid: "agt_LOCAL000000000000000000001",
  ownerUid: "prs_me",
  runtime: "claude",
  model: "opus",
  state: "running",
  pid: 42,
  processAlive: true,
  online: true,
  lastHeartbeatAt: new Date().toISOString(),
  daemonInstalled: true,
  daemonLoaded: true,
  dir: "/tmp/HQ/personal/workers/assistant",
};

const ROSTER = {
  agents: [
    {
      agentUid: CLOUD_UID,
      uid: CLOUD_UID,
      companyUid: "cmp_indigo",
      name: "izzy",
      displayName: "Izzy",
      status: "ready",
      setupPhase: "ready",
    },
    {
      agentUid: OTHER_UID,
      uid: OTHER_UID,
      companyUid: "cmp_other",
      name: "rex",
      displayName: "Rex",
      status: "provisioning",
      setupPhase: "provisioning",
    },
  ],
};

const COMPANIES = [
  {
    slug: "indigo",
    displayName: "Indigo",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_indigo",
    role: "owner",
    membershipStatus: "active",
  },
  {
    slug: "other",
    displayName: "Other Co",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_other",
    role: "member",
    membershipStatus: "active",
  },
] as unknown as NonNullable<Parameters<typeof cloudBotsFromRoster>[1]>["companies"];

function fakeAdapter(input: {
  bots?: Partial<NonNullable<PlatformAdapter["bots"]>> | null;
  agents?: Partial<PlatformAdapter["agents"]>;
}): PlatformAdapter {
  const agents = {
    listMobileRoster: vi.fn(async () => ok(ROSTER)),
    stop: vi.fn(async () => ok({})),
    start: vi.fn(async () => ok({})),
    deprovision: vi.fn(async () => ok({})),
    ...input.agents,
  };
  const bots =
    input.bots === null
      ? undefined
      : {
          list: vi.fn(async () => ok({ bots: [LOCAL_BOT] })),
          create: vi.fn(async () => ok({})),
          start: vi.fn(async () => ok({})),
          stop: vi.fn(async () => ok({})),
          remove: vi.fn(async () => ok({})),
          ...input.bots,
        };
  return {
    kind: bots ? "tauri" : "web",
    isAvailable: () => false,
    capabilities: {},
    agents,
    bots,
    sessions: {},
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settleFlow(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const QUOTE: AgentProvisionOptionsView = {
  defaultInstanceType: "t3.medium",
  catalogVersion: "catalog-7",
  options: [
    {
      key: "basic",
      productName: "Basic",
      instanceType: "t3.medium",
      listCents: 10000,
      default: true,
      selectable: true,
      netMonthlyCents: 10000,
      deltaCents: 10000,
      unavailableReason: null,
      notBilled: false,
      lanes: 3,
      workers: 3,
    },
  ],
};

function seam(on: boolean): DirectCloudCreate {
  return {
    isEnabled: vi.fn(async () => on),
    anyEnabled: vi.fn(async () => on),
    availability: vi.fn(async () => ({ state: "available" as const })),
    client: {} as DirectCloudCreate["client"],
  };
}

function cloudAdapter(): PlatformAdapter {
  const base = fakeAdapter({
    bots: { workers: vi.fn(async () => ok({ workers: [] })) },
    agents: { getProvisionOptions: vi.fn(async () => ok(QUOTE)) },
  });
  return { ...base, identity: { hasFeature: vi.fn(async () => ok(true)) } } as unknown as PlatformAdapter;
}

async function mountPane(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(BotsSettingsPane, {
    target: host,
    props: { adapter: cloudAdapter(), companies: COMPANIES as never, ...props },
  });
  await settleFlow();
}

async function openHomeStep(): Promise<void> {
  await vi.waitFor(() => {
    expect(host.querySelector('[data-testid="settings-bots-create-button"]')).not.toBeNull();
  });
  host.querySelector<HTMLButtonElement>('[data-testid="settings-bots-create-button"]')!.click();
  await settleFlow();
  host.querySelector<HTMLButtonElement>('[data-testid="create-bot-next"]')!.click();
  await settleFlow();
}

describe("Settings › Bots cloud creation (agents.desktop-agent-creation)", () => {
  it("flag off: Cloud stays unavailable here, as before", async () => {
    const oncreatecloudbot = vi.fn();
    await mountPane({ directCloud: seam(false), oncreatecloudbot });
    await openHomeStep();
    expect(host.querySelector('[data-testid="chat-bot-where-cloud"]')).toBeNull();
  });

  it("no seam from the host: unchanged", async () => {
    await mountPane({});
    await openHomeStep();
    expect(host.querySelector('[data-testid="chat-bot-where-cloud"]')).toBeNull();
  });

  it("flag on: creates a cloud bot through the host and closes the dialog", async () => {
    const oncreatecloudbot = vi.fn(async () => ({
      ok: true as const,
      target: { channelId: "", cardId: null, cardKind: null, agentUid: "agt_new" },
    }));
    await mountPane({ directCloud: seam(true), oncreatecloudbot });
    await openHomeStep();
    host.querySelector<HTMLButtonElement>('[data-testid="chat-bot-where-cloud"]')!.click();
    await settleFlow();
    host.querySelector<HTMLButtonElement>('[data-testid="create-bot-next"]')!.click();
    await settleFlow();
    host.querySelector<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.click();
    await vi.waitFor(() => expect(oncreatecloudbot).toHaveBeenCalledOnce());
    const [companyUid, draft] = oncreatecloudbot.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(companyUid).toBe("cmp_indigo");
    expect(draft).toMatchObject({
      quote: { instanceType: "t3.medium", netMonthlyCents: 10000, catalogVersion: "catalog-7" },
    });
    expect(String(draft.idempotencyKey)).toMatch(/^desktop-new-bot-/);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="settings-bots-create-dialog"]')).toBeNull();
    });
  });

  it("flag on: a refusal stays in the dialog with its fix", async () => {
    const oncreatecloudbot = vi.fn(async () => ({
      ok: false as const,
      reason: "Cloud bots need the Agents plan. Indigo isn't on it yet.",
      blocked: true,
      fix: { kind: "checkout" as const, url: "https://checkout.test/x", label: "Upgrade plan" },
    }));
    await mountPane({ directCloud: seam(true), oncreatecloudbot });
    await openHomeStep();
    host.querySelector<HTMLButtonElement>('[data-testid="chat-bot-where-cloud"]')!.click();
    await settleFlow();
    host.querySelector<HTMLButtonElement>('[data-testid="create-bot-next"]')!.click();
    await settleFlow();
    host.querySelector<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.click();
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="chat-create-entry-error"]')?.textContent).toContain("Agents plan"),
    );
    expect(host.querySelector('[data-testid="chat-create-entry-fix"]')?.getAttribute("href")).toBe("https://checkout.test/x");
    expect(host.querySelector('[data-testid="settings-bots-create-dialog"]')).not.toBeNull();
  });
});
