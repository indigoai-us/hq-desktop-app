// @vitest-environment happy-dom
/**
 * Bot pane Profile | Jobs: the Jobs tab lists the bot's scheduled jobs
 * (failing first, then next run), filters by kind and failures, and a row
 * opens the detail with the full prompt, Copy, schedule, run history and
 * Pause through the agents API.
 */
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProfilePaneHost from "./ProfilePaneHost.svelte";

let component: ReturnType<typeof mount> | null = null;
let host: HTMLElement;

const soon = (min: number) => new Date(Date.now() + min * 60000).toISOString();

const PROMPT = "Please post the standup notes to #team.\nInclude blockers from yesterday's threads.";

function agentsApi(pauseOk = true) {
  return {
    listJobs: vi.fn(async () => ({
      ok: true as const,
      value: { jobs: [
        { jobId: "job_ok", prompt: "Summarize the inbox", rate: "cron(0 8 * * ? *)", schedule: { kind: "recurring", cron: "0 8 * * ? *", timezone: "UTC" }, scheduleState: "ENABLED", nextRunAt: soon(30), lastRunAt: soon(-600), lastRunOutcome: "succeeded" },
        { jobId: "job_standup", prompt: PROMPT, rate: "cron(0 9 ? * MON-FRI *)", schedule: { kind: "recurring", cron: "0 9 ? * MON-FRI *", timezone: "UTC" }, scheduleState: "ENABLED", nextRunAt: soon(120), lastRunAt: soon(-1440), lastRunOutcome: "failed" },
        { jobId: "job_once", prompt: "/indigo:launch-review", rate: "at(2030-01-01T10:00:00)", schedule: { kind: "once", at: "2030-01-01T10:00:00Z" }, scheduleState: "ENABLED", nextRunAt: soon(60 * 24 * 30) },
      ] },
    })),
    pauseJob: vi.fn(async () => (pauseOk ? { ok: true as const, value: {} } : { ok: false as const, reason: "network" as const, message: "nope" })),
    getCompanyTelemetry: vi.fn(async () => ({ ok: true as const, value: { perMember: [] } })),
    getStatus: vi.fn(async () => ({ ok: true as const, value: {} })),
    stop: vi.fn(async () => ({ ok: true as const, value: {} })),
    start: vi.fn(async () => ({ ok: true as const, value: {} })),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host.querySelector<T>(sel);
}
function click(sel: string): void {
  q<HTMLButtonElement>(sel)!.click();
  flushSync();
}
const rowNames = () => [...host.querySelectorAll('[data-testid="bot-job-row"] .t')].map((el) => el.textContent);

async function openJobsTab(agents = agentsApi()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ProfilePaneHost, {
    target: host,
    props: { kind: "bot", name: "scout", agentUid: "agt_scout", runtimeKind: "cloud", companyUid: "cmp_a", agents: agents as never },
  });
  await settle();
  click('[data-testid="bot-pane-tab-jobs"]');
  return agents;
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("bot pane Jobs tab", () => {
  it("has Profile and Jobs tabs with the job count, and the profile links to Jobs", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ProfilePaneHost, {
      target: host,
      props: { kind: "bot", name: "scout", agentUid: "agt_scout", runtimeKind: "cloud", companyUid: "cmp_a", agents: agentsApi() as never },
    });
    await settle();
    expect(q('[data-testid="bot-pane-tab-profile"]')?.getAttribute("aria-selected")).toBe("true");
    expect(q('[data-testid="bot-pane-tab-jobs"]')?.textContent).toBe("Jobs3");
    click('[data-testid="bot-profile-open-jobs"]');
    expect(q('[data-testid="bot-pane-tab-jobs"]')?.getAttribute("aria-selected")).toBe("true");
    expect(q('[data-testid="bot-jobs"]')).not.toBeNull();
  });

  it("lists failing jobs first, then by next run, with name, schedule and runs", async () => {
    await openJobsTab();
    expect(rowNames()).toEqual(["Post the standup notes to #team", "Summarize the inbox", "Launch review"]);
    const first = q('[data-testid="bot-job-row"]')!;
    expect(first.textContent).toContain("Weekdays at 9:00 AM");
    expect(first.textContent).toContain("Next in 2 h");
    expect(first.textContent).toContain("Last 1 d ago, failed");
    expect(first.querySelector(".mk.err")).not.toBeNull();
  });

  it("filters by One-off and Failed", async () => {
    await openJobsTab();
    click('[data-testid="bot-jobs-filter-one-off"]');
    expect(rowNames()).toEqual(["Launch review"]);
    click('[data-testid="bot-jobs-filter-failed"]');
    expect(rowNames()).toEqual(["Post the standup notes to #team"]);
    click('[data-testid="bot-jobs-filter-recurring"]');
    expect(rowNames()).toHaveLength(2);
  });

  it("a row opens the detail with the full prompt, Copy, schedule and history; back returns to the list", async () => {
    await openJobsTab();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    click('[data-testid="bot-job-row"]');
    expect(q('[data-testid="bot-job-detail-name"]')?.textContent).toBe("Post the standup notes to #team");
    expect(q('[data-testid="bot-job-prompt"]')?.textContent).toBe(PROMPT);
    expect(q('[data-testid="bot-job-detail-schedule"]')?.textContent).toMatch(/^Weekdays at 9:00 AM/);
    expect(q('[data-testid="bot-job-detail"]')?.textContent).toContain("Time zoneUTC");
    expect(q('[data-testid="bot-job-history-row"]')?.textContent).toContain("failed");
    click('[data-testid="bot-job-copy"]');
    await settle();
    expect(writeText).toHaveBeenCalledWith(PROMPT);
    expect(q('[data-testid="bot-job-copy"]')?.textContent).toBe("Copied");
    // Only Pause: resume and run-now are not open to people.
    const controls = [...host.querySelectorAll('[data-testid="bot-job-detail"] .controls button')].map((b) => b.textContent);
    expect(controls).toEqual(["Pause"]);
    click('[data-testid="bot-job-back"]');
    expect(q('[data-testid="bot-job-detail"]')).toBeNull();
    expect(rowNames()).toHaveLength(3);
  });

  it("Pause calls the agents API and shows the job as paused", async () => {
    const agents = await openJobsTab();
    click('[data-testid="bot-job-row"]');
    click('[data-testid="bot-job-pause"]');
    await settle();
    expect(agents.pauseJob).toHaveBeenCalledWith("agt_scout", "job_standup");
    expect(q('[data-testid="bot-job-detail-state"]')?.textContent).toBe("Paused");
    expect(q('[data-testid="bot-job-pause"]')).toBeNull();
  });

  it("a refused Pause says so and leaves the job on", async () => {
    await openJobsTab(agentsApi(false));
    click('[data-testid="bot-job-row"]');
    click('[data-testid="bot-job-pause"]');
    await settle();
    expect(q('[data-testid="bot-job-pause-error"]')?.textContent).toBe("Could not pause the job. Try again.");
    expect(q('[data-testid="bot-job-detail-state"]')?.textContent).toBe("On");
  });
});
