import { describe, expect, it } from "vitest";
import {
  botJobsFromPayload,
  deriveJobName,
  filterJobs,
  lastRunLabel,
  nextRunLabel,
  scheduleInWords,
  sortJobs,
  type BotJob,
} from "./bot-jobs.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const inMin = (n: number) => new Date(NOW.getTime() + n * 60000).toISOString();

describe("deriveJobName", () => {
  it("uses the first line, first sentence, without a polite lead-in", () => {
    expect(deriveJobName("Please check the deploy dashboard. Then post a summary to #ops.")).toBe("Check the deploy dashboard");
    expect(deriveJobName("\n\n  can you summarize yesterday's support tickets\nmore detail here")).toBe("Summarize yesterday's support tickets");
    expect(deriveJobName("Hey Scout, pull the Stripe payouts and reconcile them")).toBe("Pull the Stripe payouts and reconcile them");
  });

  it("drops markdown marks", () => {
    expect(deriveJobName("## **Weekly** report")).toBe("Weekly report");
    expect(deriveJobName("- `ping` the status page")).toBe("Ping the status page");
  });

  it("names a slash command after the command", () => {
    expect(deriveJobName("/indigo:daily-brief for the team")).toBe("Daily brief");
    expect(deriveJobName("/signals")).toBe("Signals");
  });

  it("stops at a colon that introduces detail", () => {
    expect(deriveJobName("Morning brief: calendar, inbox, and open PRs")).toBe("Morning brief");
  });

  it("cuts long names on a word boundary", () => {
    const name = deriveJobName("Go through every open pull request across all of the company repositories and leave review comments");
    expect(name.length).toBeLessThanOrEqual(49);
    expect(name.endsWith("…")).toBe(true);
    expect(name).toBe("Go through every open pull request across all…");
  });

  it("falls back when the prompt is empty", () => {
    expect(deriveJobName("")).toBe("Untitled job");
    expect(deriveJobName("   \n  ")).toBe("Untitled job");
  });
});

describe("scheduleInWords", () => {
  it("reads common cron shapes in plain words", () => {
    expect(scheduleInWords("cron(0 9 ? * MON-FRI *)", null, NOW)).toBe("Weekdays at 9:00 AM");
    expect(scheduleInWords("cron(30 17 ? * FRI *)", null, NOW)).toBe("Every Friday at 5:30 PM");
    expect(scheduleInWords("cron(0 8 ? * MON,WED,FRI *)", null, NOW)).toBe("Mon, Wed, Fri at 8:00 AM");
    expect(scheduleInWords("cron(0/15 * * * ? *)", null, NOW)).toBe("Every 15 minutes");
    expect(scheduleInWords("cron(0 * * * ? *)", null, NOW)).toBe("Every hour");
    expect(scheduleInWords("cron(0 7 * * ? *)", null, NOW)).toBe("Every day at 7:00 AM");
  });

  it("adds the time zone and keeps rates and one-off times readable", () => {
    expect(scheduleInWords("cron(0 9 ? * MON-FRI *)", { kind: "recurring", timezone: "America/Denver" }, NOW)).toMatch(/^Weekdays at 9:00 AM M[DS]T$/);
    expect(scheduleInWords("rate(2 hours)", null, NOW)).toBe("Every 2 hours");
    expect(scheduleInWords("at(2026-10-09T15:00:00)", { kind: "once", at: "2026-10-09T15:00:00Z", timezone: "UTC" }, NOW)).toMatch(/^Once on Oct 9, 2026/);
  });
});

describe("labels", () => {
  it("next run is relative when near, a day and time when far", () => {
    expect(nextRunLabel(inMin(12), NOW)).toBe("in 12 min");
    expect(nextRunLabel(inMin(180), NOW)).toBe("in 3 h");
    expect(nextRunLabel(inMin(-5), NOW)).toBe("due now");
    expect(nextRunLabel(null, NOW)).toBe("");
    expect(nextRunLabel(inMin(60 * 24 * 5), NOW)).toMatch(/^Oct 11, /);
  });

  it("last run reads as time ago", () => {
    expect(lastRunLabel(inMin(-4), NOW)).toBe("4 min ago");
    expect(lastRunLabel(inMin(-180), NOW)).toBe("3 h ago");
    expect(lastRunLabel(inMin(-60 * 50), NOW)).toBe("2 d ago");
  });
});

describe("botJobsFromPayload", () => {
  it("maps the operator list row", () => {
    const [job] = botJobsFromPayload({ jobs: [{
      jobId: "job_1",
      prompt: "Please post the standup notes.",
      rate: "cron(0 9 ? * MON-FRI *)",
      schedule: { kind: "recurring", cron: "0 9 ? * MON-FRI *", timezone: "UTC" },
      scheduleState: "ENABLED",
      status: "active",
      nextRunAt: inMin(30),
      lastRunAt: inMin(-60 * 24),
      lastRunOutcome: "failed",
    }] }, NOW);
    expect(job).toMatchObject({
      id: "job_1",
      name: "Post the standup notes",
      kind: "recurring",
      enabled: true,
      timezone: "UTC",
      lastOutcome: "failed",
      lastOutcomeKind: "failed",
      nextRunAt: inMin(30),
    });
    expect(job!.schedule).toMatch(/^Weekdays at 9:00 AM/);
  });

  it("treats at() and once schedules as one-off and DISABLED as paused", () => {
    const [job] = botJobsFromPayload([{ jobId: "job_2", prompt: "x", rate: "at(2026-10-09T15:00:00)", scheduleState: "DISABLED", schedule: { kind: "once", at: "2026-10-09T15:00:00Z" } }], NOW);
    expect(job).toMatchObject({ kind: "one-off", enabled: false });
  });

  it("skips rows with no id and tolerates the older shape", () => {
    const rows = botJobsFromPayload({ jobs: [{ prompt: "no id" }, { jobId: "j1", prompt: "Morning brief", schedule: "0 9 * * *", active: true }] }, NOW);
    expect(rows.map((r) => r.id)).toEqual(["j1"]);
    expect(rows[0]!.enabled).toBe(true);
  });
});

function job(over: Partial<BotJob>): BotJob {
  return {
    id: "j",
    name: "Job",
    prompt: "",
    kind: "recurring",
    schedule: "",
    expression: "",
    timezone: null,
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    lastOutcome: null,
    lastOutcomeKind: "unknown",
    ...over,
  };
}

describe("sort and filter", () => {
  const jobs = [
    job({ id: "later", name: "Later", nextRunAt: inMin(300) }),
    job({ id: "paused", name: "Paused", enabled: false, nextRunAt: inMin(1) }),
    job({ id: "fail-late", name: "Fail late", lastOutcomeKind: "failed", nextRunAt: inMin(200) }),
    job({ id: "soon", name: "Soon", nextRunAt: inMin(5) }),
    job({ id: "once", name: "Once", kind: "one-off", nextRunAt: inMin(60) }),
    job({ id: "fail-soon", name: "Fail soon", lastOutcomeKind: "failed", nextRunAt: inMin(10) }),
  ];

  it("puts failing jobs first, then the soonest next run, paused and unknown last", () => {
    expect(sortJobs(jobs).map((j) => j.id)).toEqual(["fail-soon", "fail-late", "soon", "once", "later", "paused"]);
  });

  it("filters by recurring, one-off and failed", () => {
    expect(filterJobs(jobs, "all")).toHaveLength(6);
    expect(filterJobs(jobs, "one-off").map((j) => j.id)).toEqual(["once"]);
    expect(filterJobs(jobs, "recurring")).toHaveLength(5);
    expect(filterJobs(jobs, "failed").map((j) => j.id)).toEqual(["fail-late", "fail-soon"]);
  });
});
