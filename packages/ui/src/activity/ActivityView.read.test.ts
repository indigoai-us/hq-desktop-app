// @vitest-environment happy-dom
// BLANK-1-31: company Activity reads hq-pro GET /v1/telemetry/company (the web
// Activity read) for the chosen range, with the shared loader, a failed line
// with Try again, true-empty copy, and the cache shown while refreshing.
import { failure, ok } from "@hq/platform";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ActivityView from "./ActivityView.svelte";
import { activityFromCompanyTelemetry } from "./activity-model";

// Producer shape from hq-pro readCompanyTelemetry (ids redacted).
const tokens = (input: number, output: number) => [{ model: "claude", input, output, cacheCreation: 10, cacheRead: 90 }];
const skills = (bySkill: { skill: string; count: number }[]) => ({ total: bySkill.reduce((n, s) => n + s.count, 0), bySkill });
const COMPANY_TELEMETRY = {
  company: { uid: "cmp_x", slug: "acme" },
  range: { from: "2026-09-04", to: "2026-10-03" },
  daily: [
    { date: "2026-10-02", tokensByModel: tokens(300, 100), skills: skills([]), commandsBySource: { typed: 0, model: 0 }, services: { total: 0, byService: [] }, distinctSessions: 2, events: 4 },
    { date: "2026-10-01", tokensByModel: tokens(100, 0), skills: skills([]), commandsBySource: { typed: 0, model: 0 }, services: { total: 0, byService: [] }, distinctSessions: 1, events: 1 },
  ],
  series: [],
  totals: { tokensByModel: tokens(400, 100), skills: skills([]), commandsBySource: { typed: 0, model: 0 }, services: { total: 0, byService: [] }, distinctSessions: 3, events: 5 },
  perMember: [
    {
      personUid: "prs_a",
      email: "ada@example.com",
      label: "Ada",
      totals: { tokensByModel: tokens(1000, 500), skills: skills([{ skill: "run-project", count: 4 }]), commandsBySource: { typed: 1, model: 3 }, services: { total: 0, byService: [] }, distinctSessions: 5, events: 12 },
      outcomes: { byType: { prMerged: 1, storyCompleted: 3, deploySucceeded: 2, projectShipped: 0 }, total: 6, prMergedDerived: 0 },
      lastActiveAt: "2026-10-02T12:00:00Z",
    },
    {
      personUid: "agt_scout",
      email: "",
      label: "Scout",
      totals: { tokensByModel: tokens(10, 5), skills: skills([]), commandsBySource: { typed: 0, model: 0 }, services: { total: 0, byService: [] }, distinctSessions: 1, events: 1 },
    },
    {
      personUid: "prs_idle",
      email: "idle@example.com",
      label: "",
      totals: { tokensByModel: [], skills: skills([]), commandsBySource: { typed: 0, model: 0 }, services: { total: 0, byService: [] }, distinctSessions: 0, events: 0 },
    },
  ],
  coverage: { attributed: 3, unattributed: 1 },
};

describe("BLANK-1-31 company Activity reads company telemetry", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
    localStorage.clear();
  });

  const settle = async () => {
    flushSync();
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    flushSync();
  };

  function mountWith(getTeamTelemetry: (...args: unknown[]) => Promise<unknown>) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(ActivityView, {
      target,
      props: { slug: "acme", companyLabel: "Acme", adapter: { company: { getTeamTelemetry } } as never },
    });
    return target;
  }

  it("parses the producer shape", () => {
    const snap = activityFromCompanyTelemetry(COMPANY_TELEMETRY);
    expect(snap.members.map((m) => [m.name, m.tokens, m.sessions, m.stories, m.deploys, m.topSkill, m.bot])).toEqual([
      ["Ada", 1600, 5, 3, 2, "run-project", false],
      ["Scout", 115, 1, 0, 0, "", true],
    ]);
    expect(snap.dayWeights).toEqual([200, 500]);
    expect(snap.attributedPct).toBe(75);
    expect(() => activityFromCompanyTelemetry({ grouped: {} })).toThrow();
  });

  it("reads the chosen range and shows the company's members", async () => {
    const read = vi.fn(async () => ok(COMPANY_TELEMETRY));
    const target = mountWith(read);
    await settle();
    expect(read).toHaveBeenCalledWith("acme", expect.objectContaining({ from: expect.any(String), to: expect.any(String) }));
    const [, range] = read.mock.calls[0] as unknown as [string, { from: string; to: string }];
    expect((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000).toBe(29);
    const names = [...target.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent);
    expect(names).toEqual(["Ada", "Scout"]);
    expect(target.textContent).toContain("75% attributed");
  });

  it("shows the shared loader while the first read is in flight", async () => {
    const target = mountWith(() => new Promise(() => {}));
    await settle();
    expect(target.querySelector("[data-testid='activity-loader']")).toBeTruthy();
    expect(target.querySelector("[data-testid='activity-empty']")).toBeNull();
  });

  it("shows the failed line with Try again, never the empty copy, and retries", async () => {
    const read = vi.fn(async () => failure("network", "HTTP 502 Bad Gateway"));
    const target = mountWith(read);
    await settle();
    expect(target.querySelector("[data-testid='activity-failed']")?.textContent).toContain("Could not load activity.");
    expect(target.textContent).not.toContain("502");
    expect(target.querySelector("[data-testid='activity-empty']")).toBeNull();
    read.mockImplementation(async () => ok(COMPANY_TELEMETRY));
    target.querySelector<HTMLButtonElement>("[data-testid='activity-retry']")!.click();
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(target.querySelector("[data-testid='activity-failed']")).toBeNull();
  });

  it("shows the true-empty copy when nobody was active in the range", async () => {
    const target = mountWith(async () => ok({ ...COMPANY_TELEMETRY, perMember: [], daily: [] }));
    await settle();
    expect(target.querySelector("[data-testid='activity-empty']")?.textContent).toContain("No team activity in this range yet.");
  });

  it("keeps the cached snapshot on screen while a refresh runs", async () => {
    localStorage.setItem(
      "hq-activity-cache:acme:30d",
      JSON.stringify({ ...activityFromCompanyTelemetry(COMPANY_TELEMETRY), members: [{ ...activityFromCompanyTelemetry(COMPANY_TELEMETRY).members[0], name: "Cached Ada" }] }),
    );
    const target = mountWith(() => new Promise(() => {}));
    await settle();
    expect(target.querySelector("[data-testid='activity-loader']")).toBeNull();
    expect(target.textContent).toContain("Cached Ada");
  });
});
