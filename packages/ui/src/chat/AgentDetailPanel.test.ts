// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type AgentsApi } from "@hq/platform";

import AgentDetailPanel from "./AgentDetailPanel.svelte";
import type { AvatarPack } from "../avatars/types.js";

const PACKS: AvatarPack[] = [
  {
    id: "generated-marks",
    name: "Generated marks",
    version: "1.0.0",
    author: "HQ",
    baseUrl: "builtin:generated-marks",
    items: [
      { id: "agent-01", name: "Mark 01", src: "a.png", tags: ["generated"] },
    ],
  },
];

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const JOBS = {
  jobs: [
    {
      jobId: "job_1",
      prompt: "Daily digest\nbody",
      rate: "rate(1 hour)",
      scheduleState: "ENABLED",
      lastRunOutcome: "succeeded",
      lastRunAt: "2026-09-01T14:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      status: "active",
      schedule: { kind: "recurring", timezone: "UTC" },
    },
  ],
};

const STATUS = {
  agent: {
    uid: "agt_izzy",
    name: "Izzy",
    companyUid: "cmp_indigo",
    provider: "grok",
    codexModel: "grok-4.6",
    profile: { displayName: "Izzy", description: "Fleet agent" },
    runtime: {
      status: "running",
      lastHeartbeat: { components: { task: "ok" } },
    },
  },
  setupState: { phase: "ready" },
};

const TELEMETRY = {
  perMember: [
    {
      personUid: "agt_izzy",
      totals: {
        distinctSessions: 4,
        tokensByModel: [{ model: "grok-4", input: 900, output: 100 }],
        skills: { bySkill: [{ skill: "standup", count: 3 }] },
      },
      outcomes: { byType: { storyCompleted: 2, deploySucceeded: 1 } },
      efficiency: 8,
      trend: [1, 3, 2],
      activeProjects: ["hq-desktop-app"],
    },
  ],
};

function agentsApi(over: Partial<AgentsApi> = {}): AgentsApi {
  return {
    getProvisionOptions: async () => ok({ defaultInstanceType: "t4g.medium", catalogVersion: "test", options: [] }),
    getStatus: async () => ok(STATUS),
    attachSlack: async () => ok({ config: {} }),
    submitSlackAppToken: async () => ok({ ok: true }),
    listMobileRoster: async () => ok({ agents: [] }),
    listJobs: async () => ok(JOBS),
    pauseJob: async () => ok({ ok: true }),
    updateProfile: async () => ok({ uid: "agt_izzy" }),
    stop: async () => ok({ uid: "agt_izzy" }),
    start: async () => ok({ uid: "agt_izzy" }),
    retryProvisioning: async () => ok({ uid: "agt_izzy" }),
    deprovision: async () => ok({ uid: "agt_izzy" }),
    listOwners: async () =>
      ok({
        owners: [
          {
            personUid: "prs_corey",
            displayName: "Corey",
            kind: "creator",
            status: "active",
          },
        ],
      }),
    getCompanyTelemetry: async () => ok(TELEMETRY),
    ...over,
  };
}

async function mountPanel(over: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(AgentDetailPanel, {
    target: host,
    props: {
      agentUid: "agt_izzy",
      displayName: "Izzy",
      companyUid: "cmp_indigo",
      companyNames: { cmp_indigo: "Indigo" },
      adapter: { agents: agentsApi() },
      self: { uid: "prs_corey" },
      packs: PACKS,
      ...over,
    },
  });
  await tick();
  await vi.waitFor(() => {
    expect(
      host.querySelector('[data-testid="agent-detail-name"]')?.textContent,
    ).toContain("Izzy");
  });
  await vi.waitFor(() => {
    const status = host.querySelector('[data-testid="agent-detail-status"]')
      ?.textContent;
    const jobsUnavailable = host.querySelector(
      '[data-testid="agent-detail-jobs-unavailable"]',
    );
    const jobsEmpty = host.querySelector('[data-testid="agent-detail-jobs-empty"]');
    const jobRow = host.querySelector('[data-testid="agent-detail-job-row"]');
    expect(
      jobRow || jobsEmpty || jobsUnavailable || status?.includes("WORKING"),
    ).toBeTruthy();
  });
  return host;
}

describe("AgentDetailPanel", () => {
  it("renders header, jobs, and usage from fixture adapter data", async () => {
    await mountPanel();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="agent-detail-status"]')?.textContent,
      ).toContain("BOT · WORKING");
    });
    expect(
      host.querySelector('[data-testid="agent-detail-description"]')
        ?.textContent,
    ).toContain("Fleet agent");
    expect(
      host.querySelector('[data-testid="agent-detail-owner"]')?.textContent,
    ).toBe("Corey");
    expect(
      host.querySelector('[data-testid="agent-detail-companies"]')?.textContent,
    ).toContain("Indigo");
    expect(
      host.querySelector('[data-testid="agent-detail-uid"]')?.textContent,
    ).toContain("agt_izzy");
    expect(
      host.querySelector('[data-testid="agent-detail-job-row"]')?.textContent,
    ).toContain("Daily digest");
    expect(
      host.querySelector('[data-testid="agent-detail-usage-tokens"]')
        ?.textContent,
    ).toBe("1.0k");
    expect(
      host.querySelector('[data-testid="agent-detail-avatar-picker-slot"]'),
    ).not.toBeNull();
    expect(host.querySelector('[data-testid="avatar-pack-picker"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="avatar-use-generated"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="avatar-pack-save"]')).not.toBeNull();
  });

  it("expands a job row to the full prompt", async () => {
    await mountPanel();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="agent-detail-job-row"]'),
      ).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="agent-detail-job-prompt"]')).toBeNull();
    (
      host.querySelector(
        '[data-testid="agent-detail-job-row"] .ad-job-toggle',
      ) as HTMLButtonElement
    ).click();
    await tick();
    expect(
      host.querySelector('[data-testid="agent-detail-job-prompt"]')?.textContent,
    ).toContain("Daily digest");
  });

  it("shows empty and unavailable section states", async () => {
    await mountPanel({
      adapter: {
        agents: agentsApi({
          listJobs: async () => ok({ jobs: [] }),
          getCompanyTelemetry: async () =>
            failure("http-403", "Forbidden: owner or admin role required"),
        }),
      },
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="agent-detail-jobs-empty"]'),
      ).not.toBeNull();
      expect(
        host.querySelector('[data-testid="agent-detail-usage-unavailable"]')
          ?.textContent,
      ).toContain("owner or admin");
    });
  });

  it("hides settings for non-owners and saves the profile payload for owners", async () => {
    const updateProfile = vi.fn(async () => ok({ uid: "agt_izzy" }));
    await mountPanel({
      adapter: {
        agents: agentsApi({
          getStatus: async () =>
            failure("http-403", "Forbidden: owner or admin role required"),
          listOwners: async () => ok({ owners: [] }),
          updateProfile,
        }),
      },
      isAdmin: false,
      self: { uid: "prs_member" },
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="agent-detail-settings"]'),
      ).toBeNull();
    });

    if (component) await unmount(component);
    host.remove();
    await mountPanel({
      adapter: { agents: agentsApi({ updateProfile }) },
      isAdmin: true,
    });
    const name = host.querySelector(
      '[data-testid="agent-detail-name-input"]',
    ) as HTMLInputElement;
    const desc = host.querySelector(
      '[data-testid="agent-detail-description-input"]',
    ) as HTMLTextAreaElement;
    expect(name).not.toBeNull();
    name.value = "Izzy Prime";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    desc.value = "Updated";
    desc.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (
      host.querySelector(
        '[data-testid="agent-detail-save"]',
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith("agt_izzy", {
        displayName: "Izzy Prime",
        description: "Updated",
      });
    });
  });

  it("forwards pack-picker save from the avatar slot", async () => {
    const onsaveavatar = vi.fn(async () => {});
    await mountPanel({ isAdmin: true, onsaveavatar });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="avatar-pack-picker"]'),
      ).not.toBeNull();
    });
    (
      host.querySelector(
        '[data-testid="avatar-use-generated"]',
      ) as HTMLButtonElement
    ).click();
    (
      host.querySelector('[data-testid="avatar-pack-save"]') as HTMLButtonElement
    ).click();
    await tick();
    expect(onsaveavatar).toHaveBeenCalledWith({ kind: "generated" });
  });
});

const PROFILE = {
  schemaVersion: 2,
  agent: {
    uid: "agt_izzy",
    displayName: "Izzy",
    title: "Chief of Staff",
    description: "Executive Assistant",
    companyUid: "cmp_indigo",
    owner: { uid: "prs_corey", name: "Corey" },
    role: "admin",
    connected: true,
  },
  brain: {
    model: "grok-4.7",
    provider: "grok",
    reasoningEffort: "low",
    logins: [{ provider: "grok", status: "authorized", mode: "subscription" }],
  },
  box: {
    persona: { soul: "You are Izzy.", customized: true },
    skills: [{ name: "email-triage" }],
    routines: [
      {
        id: "r1",
        name: "Morning triage",
        prompt: "Triage email",
        schedule: { cadence: "daily", expr: "5 14 * * *", display: "14:05 UTC daily" },
        enabled: true,
      },
    ],
    platforms: [{ name: "slack", state: "connected" }],
    channels: {},
    integrations: {
      probedAt: "2026-10-07T11:38:10Z",
      featured: ["notion"],
      ready: [{ provider: "notion", name: "Notion", tools: 3 }],
      attention: [
        { provider: "linear", name: "Linear", reason: "needs-reauth", fix: "Reconnect this integration." },
      ],
    },
  },
  boxFreshness: { fetchedAt: "2026-09-01T14:50:00.000Z", source: "cache" },
  editable: { title: true, description: true },
};

describe("AgentDetailPanel profile endpoint", () => {
  it("builds the panel from the profile and skips the calls it covers", async () => {
    const getStatus = vi.fn(async () => ok(STATUS));
    const listMobileRoster = vi.fn(async () => ok({ agents: [] }));
    const listJobs = vi.fn(async () => ok(JOBS));
    const listOwners = vi.fn(async () => ok({ owners: [] }));
    const getCompanyTelemetry = vi.fn(async () => ok(TELEMETRY));
    await mountPanel({
      adapter: {
        agents: agentsApi({
          getProfile: async () => ok(PROFILE),
          getStatus,
          listMobileRoster,
          listJobs,
          listOwners,
          getCompanyTelemetry,
        }),
      },
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="agent-detail-channels"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="agent-detail-usage-tokens"]')?.textContent).toBe("1.0k");
    });
    expect(getStatus).not.toHaveBeenCalled();
    expect(listMobileRoster).not.toHaveBeenCalled();
    expect(listJobs).not.toHaveBeenCalled();
    expect(listOwners).not.toHaveBeenCalled();
    expect(getCompanyTelemetry).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="agent-detail-jobs"]')).toBeNull();
    expect(host.querySelector('[data-testid="agent-detail-channel-row"]')?.textContent).toContain("slack");
    expect(host.querySelector('[data-testid="agent-detail-apps-featured"]')?.textContent).toContain("Notion");
    expect(host.querySelector('[data-testid="agent-detail-apps-attention"]')).toBeNull();
    expect(host.querySelector('[data-testid="agent-detail-routine-row"]')?.textContent).toContain("Morning triage");
    expect(host.querySelector('[data-testid="agent-detail-brain-model"]')?.textContent).toContain("grok-4.7");
    expect(host.querySelector('[data-testid="agent-detail-instructions"]')).toBeNull();
    expect(host.querySelector('[data-testid="agent-detail-skills"]')).toBeNull();
    expect(host.querySelector('[data-testid="agent-detail-freshness"]')?.textContent).toContain("saved copy");
  });

  it("falls back to the existing calls when the profile is not served", async () => {
    const getStatus = vi.fn(async () => ok(STATUS));
    const listJobs = vi.fn(async () => ok(JOBS));
    await mountPanel({
      adapter: {
        agents: agentsApi({
          getProfile: async () => failure("http-404", "Not found"),
          getStatus,
          listJobs,
        }),
      },
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="agent-detail-job-row"]')).not.toBeNull();
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(listJobs).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="agent-detail-channels"]')).toBeNull();
    expect(host.querySelector('[data-testid="agent-detail-freshness"]')).toBeNull();
  });

  it("sends routine actions through the runtime relay", async () => {
    const runtimeAction = vi.fn(async () => ok({ ok: true }));
    await mountPanel({
      adapter: {
        agents: agentsApi({ getProfile: async () => ok(PROFILE), runtimeAction }),
      },
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="agent-detail-routine-row"]')).not.toBeNull();
    });
    (host.querySelector('[data-testid="agent-detail-routine-toggle"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(runtimeAction).toHaveBeenCalledWith(
        "agt_izzy",
        expect.objectContaining({ actionId: "cron.pause", params: { jobId: "r1" } }),
      );
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="agent-detail-routine-badge"]')?.textContent).toContain("PAUSED");
    });
  });
});

const EXTENDED_PROFILE = {
  ...PROFILE,
  box: {
    ...PROFILE.box,
    routines: [
      ...PROFILE.box.routines,
      {
        id: "h1",
        name: "HQ digest",
        prompt: "Digest",
        schedule: { cadence: "weekly", expr: "0 9 * * 1" },
        enabled: true,
        source: "hq",
        editable: false,
      },
    ],
    integrations: {
      ...PROFILE.box.integrations,
      featured: ["notion", "linear"],
    },
  },
};

describe("AgentDetailPanel routines and apps", () => {
  async function mountWith() {
    await mountPanel({ adapter: { agents: agentsApi({ getProfile: async () => ok(EXTENDED_PROFILE) }) } });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="agent-detail-routine-row"]')).not.toBeNull();
    });
  }
  it("lists only connected platforms and says so when none are connected", async () => {
    const profile = {
      ...PROFILE,
      box: {
        ...PROFILE.box,
        platforms: [
          { name: "slack", state: "connected" },
          { name: "discord", state: "disconnected" },
        ],
      },
    };
    await mountPanel({ adapter: { agents: agentsApi({ getProfile: async () => ok(profile) }) } });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="agent-detail-channels"]')).not.toBeNull();
    });
    const rows = [...host.querySelectorAll('[data-testid="agent-detail-channel-row"]')];
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("slack")]);
    expect(host.querySelector('[data-testid="agent-detail-channels"]')?.textContent).not.toContain("discord");
  });

  it("shows the empty line when no platform is connected", async () => {
    const profile = { ...PROFILE, box: { ...PROFILE.box, platforms: [{ name: "slack", state: "error" }] } };
    await mountPanel({ adapter: { agents: agentsApi({ getProfile: async () => ok(profile) }) } });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="agent-detail-channels"]')?.textContent).toContain("No connected platforms.");
    });
    expect(host.querySelector('[data-testid="agent-detail-channel-row"]')).toBeNull();
  });


  it("tags HQ routines and hides their edit controls", async () => {
    await mountWith();
    const rows = [...host.querySelectorAll('[data-testid="agent-detail-routine-row"]')];
    const hq = rows.find((r) => r.textContent?.includes("HQ digest"))!;
    expect(hq.querySelector('[data-testid="agent-detail-routine-source"]')?.textContent).toBe("HQ");
    expect(hq.querySelector('[data-testid="agent-detail-routine-toggle"]')).toBeNull();
    expect(hq.querySelector('[data-testid="agent-detail-routine-edit"]')).toBeNull();
    const own = rows.find((r) => r.textContent?.includes("Morning triage"))!;
    expect(own.querySelector('[data-testid="agent-detail-routine-toggle"]')).not.toBeNull();
  });

  it("lists featured providers that are not ready with a Connect button", async () => {
    await mountWith();
    const rows = host.querySelectorAll('[data-testid="agent-detail-app-connect-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Linear");
    expect(rows[0].querySelector("button")?.textContent).toContain("Connect");
  });
});
