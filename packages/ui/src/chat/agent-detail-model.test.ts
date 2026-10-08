import { describe, expect, it } from "vitest";

import {
  createdAtFromJobId,
  deriveAgentWorkStatus,
  draftFromRoutine,
  emptyRoutineDraft,
  freshnessNote,
  formatJobCadence,
  formatJobOutcome,
  formatRunningFor,
  formatTokenCount,
  groupRoutines,
  headerFromMobileRoster,
  headerFromStatusPayload,
  jobTitleFromPrompt,
  jobsFromPayload,
  ownerLabelFromPayload,
  ownersIncludePerson,
  profileFromPayload,
  routineActionRequest,
  routineBodyFromDraft,
  usageFromCompanyTelemetry,
  skillTextFromResult,
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

const PROFILE_FIXTURE = {
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
        lastStatus: "ok",
      },
      {
        id: "r2",
        name: "Friday wrap",
        prompt: "Wrap up",
        schedule: { cadence: "weekly", expr: "0 16 * * 5" },
        enabled: false,
      },
    ],
    platforms: [{ name: "slack", state: "connected" }],
    channels: { slack: [{ id: "C1", name: "hq-gtm", type: "channel" }] },
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

describe("profileFromPayload", () => {
  const seed = { uid: "agt_izzy", displayName: "Izzy", companyNames: { cmp_indigo: "Indigo" } };

  it("builds the owner view from the endpoint body", () => {
    const view = profileFromPayload(PROFILE_FIXTURE, seed, NOW);
    expect(view?.header.title).toBe("Chief of Staff");
    expect(view?.header.ownerLabel).toBe("Corey");
    expect(view?.header.companies).toEqual(["Indigo"]);
    expect(view?.channels).toEqual([{ name: "slack", state: "connected" }]);
    expect(view?.apps.featured.map((a) => a.name)).toEqual(["Notion"]);
    expect(view?.apps.attention[0]?.reason).toBe("needs-reauth");
    expect(groupRoutines(view?.routines ?? []).map((g) => g.cadence)).toEqual([
      "daily",
      "weekly",
    ]);
    expect(view?.deliverOptions).toEqual([
      { value: "platform:C1", label: "slack · hq-gtm" },
    ]);
    expect(view?.persona.instructions).toBe("You are Izzy.");
    expect(view?.skills).toEqual([
      { name: "email-triage", summary: null, enabled: true, provenance: null },
    ]);
    expect(view?.routines.every((r) => r.source === "box" && r.editable)).toBe(true);
    expect(view?.apps.connectable).toEqual([]);
  });

  it("decodes skill summaries, routine source and editable, and connectable apps", () => {
    const body = {
      ...PROFILE_FIXTURE,
      box: {
        ...PROFILE_FIXTURE.box,
        skills: [
          { name: "email-triage", summary: "Sorts the inbox", enabled: false, provenance: "hq" },
        ],
        routines: [
          {
            id: "h1",
            name: "HQ sync",
            schedule: { cadence: "daily", expr: "0 9 * * *" },
            source: "hq",
            editable: false,
          },
        ],
        integrations: {
          probedAt: "2026-10-07T11:38:10Z",
          featured: ["notion", "linear"],
          ready: [{ provider: "notion", name: "Notion", tools: 3 }],
          attention: [],
        },
      },
    };
    const view = profileFromPayload(body, seed, NOW);
    expect(view?.skills).toEqual([
      { name: "email-triage", summary: "Sorts the inbox", enabled: false, provenance: "hq" },
    ]);
    expect(view?.routines[0]).toMatchObject({ source: "hq", editable: false });
    expect(view?.apps.connectable).toEqual([{ provider: "linear", name: "Linear" }]);
  });

  it("maps skill text results to the offline, not found and error states", () => {
    expect(skillTextFromResult({ ok: true, value: { name: "a", body: "# A" } }, "a")).toEqual({
      status: "ready",
      name: "a",
      body: "# A",
    });
    expect(skillTextFromResult({ ok: false, code: "http-503" }, "a")).toEqual({
      status: "offline",
      message: "The bot is offline, try again later",
    });
    expect(skillTextFromResult({ ok: false, status: 404 }, "a").status).toBe("not-found");
    expect(skillTextFromResult({ ok: false, code: "http-500" }, "a").status).toBe("error");
  });

  it("returns null for a body that is not a profile so the panel falls back", () => {
    expect(profileFromPayload({ error: "not found" }, seed)).toBeNull();
    expect(profileFromPayload(null, seed)).toBeNull();
  });

  it("marks a missing box as unavailable and notes stale data quietly", () => {
    const none = profileFromPayload({ ...PROFILE_FIXTURE, box: null }, seed, NOW);
    expect(none?.hasBox).toBe(false);
    expect(none?.freshness.source).toBe("unavailable");
    expect(freshnessNote({ source: "live", fetchedAt: null })).toBeNull();
    expect(freshnessNote({ source: "unavailable", fetchedAt: null })).toContain("not reachable");
    expect(
      freshnessNote({ source: "cache", fetchedAt: "2026-09-01T14:50:00.000Z" }, NOW),
    ).toBe("Showing a saved copy from 10m ago.");
  });
});

describe("routine bodies", () => {
  it("maps drafts to the schedule and deliver formats the phone sends", () => {
    const base = { ...emptyRoutineDraft(), name: "Triage", prompt: "Do it", time: "14:05" };
    expect(routineBodyFromDraft({ ...base, cadence: "daily", deliver: "origin" })).toEqual({
      name: "Triage",
      prompt: "Do it",
      schedule: "5 14 * * *",
      skills: [],
      deliver: "origin",
    });
    expect(
      routineBodyFromDraft({ ...base, cadence: "weekly", weekday: 5, deliver: "platform:C1" }),
    ).toMatchObject({ schedule: "5 14 * * 5", deliver: "platform:C1" });
    expect(
      routineBodyFromDraft({ ...base, cadence: "interval", intervalMinutes: 15 }),
    ).toMatchObject({ schedule: "every 15m" });
    expect(
      routineBodyFromDraft({ ...base, cadence: "once", onceAt: "2026-10-08T09:30:00Z" }),
    ).toMatchObject({ schedule: "2026-10-08T09:30:00.000Z" });
    expect(
      routineBodyFromDraft({ ...base, cadence: "custom", custom: "0 9 * * 1-5" }),
    ).toMatchObject({ schedule: "0 9 * * 1-5" });
  });

  it("leaves deliver out when unchanged and rejects incomplete drafts", () => {
    const view = profileFromPayload(PROFILE_FIXTURE, { uid: "agt_izzy", displayName: "Izzy" }, NOW);
    const draft = draftFromRoutine(view!.routines[0]!);
    expect(draft).toMatchObject({ cadence: "daily", time: "14:05", deliver: "" });
    expect(routineBodyFromDraft(draft)).not.toHaveProperty("deliver");
    expect(routineBodyFromDraft({ ...draft, name: "" })).toBeNull();
  });

  it("builds relay requests with the job id in params", () => {
    expect(routineActionRequest("cron.pause", "k1", "r1")).toEqual({
      actionId: "cron.pause",
      idempotencyKey: "k1",
      params: { jobId: "r1" },
    });
    expect(routineActionRequest("cron.create", "k2", undefined, { name: "x" })).toEqual({
      actionId: "cron.create",
      idempotencyKey: "k2",
      params: {},
      body: { name: "x" },
    });
  });
});
