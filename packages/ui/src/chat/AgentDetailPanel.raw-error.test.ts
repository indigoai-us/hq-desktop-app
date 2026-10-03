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

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

describe("AgentDetailPanel raw errors", () => {
  it("shows plain copy, not the raw adapter message, when pausing the bot fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await mountPanel({
      adapter: {
        agents: agentsApi({
          stop: async () => failure("unknown", RAW),
          getCompanyTelemetry: async () => failure("unknown", RAW),
        }),
      },
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="agent-detail-pause-agent"]')).not.toBeNull();
    });
    (host.querySelector('[data-testid="agent-detail-pause-agent"]') as HTMLButtonElement).click();
    await tick();
    (document.querySelector('[data-testid="confirm-dialog-ok"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="agent-detail-action-error"]')?.textContent,
      ).toContain("Could not pause the bot. Try again.");
    });
    expect(host.textContent).not.toContain("boom");
    expect(host.textContent).not.toContain("HTTP 500");
    for (const el of host.querySelectorAll("[title]")) {
      expect(el.getAttribute("title")).not.toContain("boom");
    }
    expect(warn).toHaveBeenCalledWith("[agent-detail] pause the bot failed", RAW);
    warn.mockRestore();
  });
});
