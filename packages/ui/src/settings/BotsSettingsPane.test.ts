// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import BotsSettingsPane from "./BotsSettingsPane.svelte";
import { cloudBotsFromRoster, cloudBotStatusLabel } from "./cloud-bots.js";

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

async function mountPane(adapter: PlatformAdapter) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(BotsSettingsPane, {
    target: host,
    props: { adapter, companies: COMPANIES as never },
  });
  await tick();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("Settings → Bots (Work shell)", () => {
  it("is a first-class ShellSettings nav item on desktop, right after AI tools", () => {
    const shell = readFileSync(
      join(import.meta.dirname, "ShellSettings.svelte"),
      "utf8",
    );
    expect(shell).toContain('{ id: "bots", label: "Bots" }');
    expect(shell.indexOf('{ id: "bots"')).toBeGreaterThan(shell.indexOf('{ id: "agents"'));
    expect(shell).toContain("BotsSettingsPane");
    expect(shell).toContain(
      'if (section.id === "bots") return Boolean(adapter?.bots || adapter?.agents);',
    );
  });

  it("drives every local action through the adapter's desktop-only bots group", () => {
    const pane = readFileSync(
      join(import.meta.dirname, "BotsSettingsPane.svelte"),
      "utf8",
    );
    for (const call of ["api.list()", "api.create({ name, runtime: newRuntime })", "api[verb](name)"]) {
      expect(pane).toContain(call);
    }
    expect(pane).not.toContain("@tauri-apps");
    expect(pane).not.toContain("fetch(");
  });

  it("renders the Local group from adapter.bots and the Cloud group from adapter.agents", async () => {
    const adapter = fakeAdapter({});
    await mountPane(adapter);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="settings-bot-assistant"]')).not.toBeNull();
      expect(host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)).not.toBeNull();
    });
    expect(adapter.agents.listMobileRoster).toHaveBeenCalledWith(null);

    const local = host.querySelector('[data-testid="settings-bots-local"]')!;
    expect(local.textContent).toContain("assistant");
    expect(local.textContent).toContain("Claude Code");
    expect(local.querySelector('[data-testid="settings-bots-create"]')).not.toBeNull();
    const localChip = local.querySelector('[data-testid="settings-bot-assistant"] [data-testid="bot-kind-chip"]');
    expect(localChip?.getAttribute("data-kind")).toBe("local");
    expect(localChip?.textContent?.trim()).toBe("Local · Claude Code");

    const cloud = host.querySelector('[data-testid="settings-bots-cloud"]')!;
    const izzy = cloud.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)!;
    expect(izzy.textContent).toContain("Izzy");
    expect(izzy.textContent).toContain("Indigo");
    expect(izzy.textContent).toContain("Idle");
    expect(izzy.querySelector('[data-testid="bot-kind-chip"]')?.getAttribute("data-kind")).toBe("cloud");
    // Owner of Indigo → can manage Izzy.
    expect(izzy.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}-pause"]`)).not.toBeNull();
    expect(izzy.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}-remove"]`)).not.toBeNull();
    // Plain member of Other Co → read-only row, plain-word status.
    const rex = cloud.querySelector(`[data-testid="settings-cloud-bot-${OTHER_UID}"]`)!;
    expect(rex.textContent).toContain("Other Co");
    expect(rex.textContent).toContain("Setting up");
    expect(rex.querySelector("button")).toBeNull();
  });

  it("pauses, resumes, and removes a managed cloud bot through adapter.agents", async () => {
    const adapter = fakeAdapter({});
    await mountPane(adapter);
    const pause = await vi.waitFor(() => {
      const el = host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-pause"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    pause.click();
    await vi.waitFor(() => expect(adapter.agents.stop).toHaveBeenCalledWith(CLOUD_UID));
    const resume = await vi.waitFor(() => {
      const el = host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-resume"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)?.textContent).toContain("Paused");
    resume.click();
    await vi.waitFor(() => expect(adapter.agents.start).toHaveBeenCalledWith(CLOUD_UID));

    // Remove needs an explicit confirm (wait for the resume round-trip to settle first).
    const remove = await vi.waitFor(() => {
      const el = host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-remove"]`);
      expect(el).not.toBeNull();
      expect(el!.disabled).toBe(false);
      return el!;
    });
    remove.click();
    await tick();
    expect(adapter.agents.deprovision).not.toHaveBeenCalled();
    host
      .querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-confirm-remove"]`)!
      .click();
    await vi.waitFor(() => expect(adapter.agents.deprovision).toHaveBeenCalledWith(CLOUD_UID));
  });

  it("shows the Cloud group alone on the web adapter (no adapter.bots)", async () => {
    const adapter = fakeAdapter({ bots: null });
    await mountPane(adapter);
    await vi.waitFor(() => {
      expect(host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="settings-bots-local-unavailable"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="settings-bots-list"]')).toBeNull();
    expect(host.querySelector('[data-testid="settings-bots-create"]')).toBeNull();
    expect(host.querySelector('[data-testid="settings-bots-error"]')).toBeNull();
  });

  it("shows per-group empty states", async () => {
    const adapter = fakeAdapter({
      bots: { list: vi.fn(async () => ok({ bots: [] })) },
      agents: { listMobileRoster: vi.fn(async () => ok({ agents: [] })) },
    });
    await mountPane(adapter);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="settings-bots-empty"]')?.textContent).toContain("No local bots yet");
      expect(host.querySelector('[data-testid="settings-bots-cloud-empty"]')?.textContent).toContain(
        "No cloud bots yet — add one from a company channel with Add bot.",
      );
    });
  });
});

describe("cloudBotsFromRoster", () => {
  it("normalizes rows, names companies, drops deprovisioned bots, and gates management by role", () => {
    const rows = cloudBotsFromRoster(
      {
        agents: [
          ...ROSTER.agents,
          { uid: "agt_GONE", displayName: "Gone", companyUid: "cmp_indigo", setupPhase: "deprovisioned" },
          { uid: CLOUD_UID, displayName: "Izzy dup", companyUid: "cmp_indigo", setupPhase: "ready" },
        ],
      },
      { companies: COMPANIES },
    );
    expect(rows.map((r) => r.uid)).toEqual([CLOUD_UID, OTHER_UID]);
    expect(rows[0]).toMatchObject({ displayName: "Izzy", companyLabel: "Indigo", status: "IDLE", canManage: true });
    expect(rows[1]).toMatchObject({ displayName: "Rex", companyLabel: "Other Co", status: "PROVISIONING", canManage: false });
  });

  it("maps statuses to plain words", () => {
    expect(cloudBotStatusLabel("WORKING")).toBe("Working");
    expect(cloudBotStatusLabel("IDLE")).toBe("Idle");
    expect(cloudBotStatusLabel("PROVISIONING", "provisioning")).toBe("Setting up");
    expect(cloudBotStatusLabel("PROVISIONING", "failed")).toBe("Setup failed");
  });
});
