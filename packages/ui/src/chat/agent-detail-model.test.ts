import { describe, expect, it } from "vitest";

import {
  createdAtFromJobId,
  deriveAgentWorkStatus,
  formatJobCadence,
  formatJobOutcome,
  formatRunningFor,
  formatTokenCount,
  headerFromMobileRoster,
  headerFromStatusPayload,
  jobTitleFromPrompt,
  jobsFromPayload,
  ownerLabelFromPayload,
  ownersIncludePerson,
  usageFromCompanyTelemetry,
} from "./agent-detail-model.js";

const NOW = new Date("2026-09-01T15:00:00.000Z");

describe("jobTitleFromPrompt", () => {
  it("uses the first non-empty line", () => {
    expect(jobTitleFromPrompt("\n  Daily standup digest\nthen more")).toBe(
      "Daily standup digest",
    );
  });

  it("falls back when the prompt is blank", () => {
    expect(jobTitleFromPrompt("   \n")).toBe("Untitled job");
  });
});

describe("formatJobCadence", () => {
  it("formats hourly and daily rates", () => {
    expect(formatJobCadence("rate(1 hour)")).toBe("Every hour");
    expect(formatJobCadence("rate(1 day)")).toBe("Every day");
    expect(formatJobCadence("rate(12 hours)")).toBe("Every 12 hours");
  });

  it("formats a daily cron with timezone", () => {
    expect(
      formatJobCadence("cron(0 9 * * ? *)", {
        timezone: "America/New_York",
      }, NOW),
    ).toMatch(/^Every day at 9 AM E[DS]T$/);
  });

  it("formats a one-shot at() expression", () => {
    expect(formatJobCadence("at(2026-09-15T13:00:00.000Z)")).toContain(
      "Once on",
    );
  });
});

describe("formatJobOutcome / running for", () => {
  it("maps last-run outcomes to the pane labels", () => {
    expect(formatJobOutcome("succeeded")).toEqual({
      label: "succeeded",
      kind: "succeeded",
    });
    expect(formatJobOutcome("skipped-precondition")).toEqual({
      label: "skipped (precondition)",
      kind: "skipped",
    });
    expect(formatJobOutcome("failed")).toEqual({
      label: "failed",
      kind: "failed",
    });
  });

  it("formats running-for from createdAt", () => {
    expect(formatRunningFor("2026-08-30T12:00:00.000Z", NOW)).toBe(
      "Running for 2 days",
    );
    expect(formatRunningFor("2026-09-01T12:00:00.000Z", NOW)).toBe(
      "Running for less than a day",
    );
  });
});

describe("createdAtFromJobId", () => {
  it("decodes a ULID timestamp from a job_ id", () => {
    // ULID 01ARZ3NDEKTSV4RRFFQ69G5FAV → 2016-07-30T23:54:41.769Z
    const iso = createdAtFromJobId("job_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(iso).toBeTruthy();
    expect(new Date(iso!).getUTCFullYear()).toBe(2016);
  });
});

describe("jobsFromPayload", () => {
  it("normalizes operator list rows", () => {
    const rows = jobsFromPayload(
      {
        jobs: [
          {
            jobId: "job_1",
            prompt: "Ping the board\nmore",
            rate: "rate(1 hour)",
            scheduleState: "ENABLED",
            lastRunOutcome: "succeeded",
            lastRunAt: "2026-09-01T14:00:00.000Z",
            createdAt: "2026-08-01T00:00:00.000Z",
            status: "active",
            schedule: { kind: "recurring", timezone: "America/New_York" },
          },
        ],
      },
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Ping the board");
    expect(rows[0]?.cadence).toBe("Every hour");
    expect(rows[0]?.active).toBe(true);
    expect(rows[0]?.lastOutcome).toBe("succeeded");
    expect(rows[0]?.runningFor).toBe("Running for 31 days");
  });
});

describe("deriveAgentWorkStatus", () => {
  it("maps setup / runtime / task health", () => {
    expect(
      deriveAgentWorkStatus({ setupPhase: "provisioning" }),
    ).toBe("PROVISIONING");
    expect(
      deriveAgentWorkStatus({
        setupPhase: "ready",
        runtimeStatus: "running",
        taskHealth: "ok",
      }),
    ).toBe("WORKING");
    expect(
      deriveAgentWorkStatus({
        setupPhase: "ready",
        runtimeStatus: "stopped",
      }),
    ).toBe("IDLE");
  });
});

describe("usageFromCompanyTelemetry", () => {
  it("extracts the agent member from company telemetry", () => {
    const usage = usageFromCompanyTelemetry(
      {
        perMember: [
          {
            personUid: "agt_izzy",
            totals: {
              distinctSessions: 4,
              tokensByModel: [
                { model: "grok-4", input: 800, output: 200 },
                { model: "gpt-5", input: 100, output: 0 },
              ],
              skills: { bySkill: [{ skill: "standup", count: 3 }] },
            },
            outcomes: { byType: { storyCompleted: 2, deploySucceeded: 1 } },
            efficiency: 12.5,
            trend: [1, 4, 2],
            activeProjects: ["hq-desktop-app"],
          },
        ],
      },
      "agt_izzy",
    );
    expect(usage?.tokens).toBe(1100);
    expect(usage?.sessions).toBe(4);
    expect(usage?.stories).toBe(2);
    expect(usage?.deploys).toBe(1);
    expect(usage?.outcomesPerMillion).toBe(12.5);
    expect(usage?.dailyTokens).toEqual([1, 4, 2]);
    expect(usage?.tokensByModel[0]?.model).toBe("grok-4");
    expect(usage?.topSkills[0]?.skill).toBe("standup");
    expect(usage?.projects).toEqual(["hq-desktop-app"]);
  });

  it("returns an empty usage view when the agent is missing", () => {
    const usage = usageFromCompanyTelemetry({ perMember: [] }, "agt_missing");
    expect(usage?.tokens).toBe(0);
    expect(usage?.sessions).toBe(0);
  });
});

describe("header / owners", () => {
  it("builds a manageable header from status", () => {
    const header = headerFromStatusPayload(
      {
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
      },
      {
        uid: "agt_izzy",
        displayName: "Izzy",
        companyUid: "cmp_indigo",
        companyNames: { cmp_indigo: "Indigo" },
      },
    );
    expect(header.displayName).toBe("Izzy");
    expect(header.description).toBe("Fleet agent");
    expect(header.status).toBe("WORKING");
    expect(header.companies).toEqual(["Indigo"]);
    expect(header.canManage).toBe(true);
    expect(header.modelLabel).toBe("grok-4.6");
  });

  it("builds a read-only header from the mobile roster", () => {
    const header = headerFromMobileRoster(
      {
        agents: [
          {
            uid: "agt_izzy",
            displayName: "Izzy",
            description: "Hello",
            setupPhase: "ready",
            status: "ready",
            companyUid: "cmp_indigo",
          },
        ],
      },
      { uid: "agt_izzy", displayName: "Izzy" },
    );
    expect(header?.canManage).toBe(false);
    expect(header?.description).toBe("Hello");
  });

  it("picks the creator owner label", () => {
    expect(
      ownerLabelFromPayload({
        owners: [
          {
            personUid: "prs_corey",
            displayName: "Corey",
            kind: "creator",
            status: "active",
          },
        ],
      }),
    ).toBe("Corey");
    expect(
      ownersIncludePerson(
        { owners: [{ personUid: "prs_corey", status: "active" }] },
        "prs_corey",
      ),
    ).toBe(true);
  });
});

describe("formatTokenCount", () => {
  it("compacts thousands and millions", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(420)).toBe("420");
    expect(formatTokenCount(1200)).toBe("1.2k");
    expect(formatTokenCount(1_200_000)).toBe("1.2M");
  });
});
