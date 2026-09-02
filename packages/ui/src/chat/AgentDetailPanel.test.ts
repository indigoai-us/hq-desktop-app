// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type AgentsApi } from "@hq/platform";

import AgentDetailPanel from "./AgentDetailPanel.svelte";

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
    getStatus: async () => ok(STATUS),
    listMobileRoster: async () => ok({ agents: [] }),
    listJobs: async () => ok(JOBS),
    pauseJob: async () => ok({ ok: true }),
    updateProfile: async () => ok({ uid: "agt_izzy" }),
    stop: async () => ok({ uid: "agt_izzy" }),
    start: async () => ok({ uid: "agt_izzy" }),
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
      ).toContain("AGENT · WORKING");
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
});
