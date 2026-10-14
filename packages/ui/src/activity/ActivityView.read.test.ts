// @vitest-environment happy-dom
// BLANK-1-31: company Activity reads hq-pro GET /v1/telemetry/company (the web
// Activity read) for the chosen range, with the shared loader, a failed line
// with Try again, true-empty copy, and the cache shown while refreshing.
import { failure, ok } from "@hq/platform";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ActivityView from "./ActivityView.svelte";
import { activityFromCompanyTelemetry, activityToCsv } from "./activity-model";

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

  function mountWith(getTeamTelemetry: (...args: unknown[]) => Promise<unknown>, onsignin?: () => Promise<void>) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(ActivityView, {
      target,
      props: { slug: "acme", companyLabel: "Acme", adapter: { company: { getTeamTelemetry } } as never, onsignin },
    });
    return target;
  }

  it("parses the producer shape", () => {
    const snap = activityFromCompanyTelemetry(COMPANY_TELEMETRY);
    expect(snap.members.map((m) => [m.name, m.tokens, m.sessions, m.stories, m.deploys, m.topSkill, m.bot])).toEqual([
      ["Ada", 1600, 5, 3, 2, "run-project", false],
      ["Scout", 115, 1, 0, 0, "", true],
    ]);
    expect(() => activityFromCompanyTelemetry({ grouped: {} })).toThrow();
  });

  it("reads the chosen range and shows the company's members", async () => {
    const read = vi.fn(async () => ok(COMPANY_TELEMETRY));
    const target = mountWith(read);
    await settle();
    expect(read).toHaveBeenCalledWith("acme", expect.objectContaining({ from: expect.any(String), to: expect.any(String) }));
    const [, range] = read.mock.calls[0] as unknown as [string, { from: string; to: string }];
    expect((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000).toBe(29);
    const names = [...target.querySelectorAll("[data-testid='activity-member-row'] .who-name")].map((el) => el.textContent?.trim());
    expect(names).toEqual(["Ada", "Scout"]);
    // OWNER-R5 shared person display in the list.
    expect(target.querySelectorAll("[data-testid='activity-member-row'] [data-testid='person-name']")).toHaveLength(2);
  });

  it("is the team view only: no Team/Tokens switch, no token chart, no attribution line", async () => {
    const target = mountWith(vi.fn(async () => ok(COMPANY_TELEMETRY)));
    await settle();
    expect(target.querySelector("[aria-label='Activity views']")).toBeNull();
    expect(target.querySelector("[data-testid='activity-tokens']")).toBeNull();
    expect(target.querySelector("[data-testid='token-day-strip']")).toBeNull();
    expect(target.textContent).not.toContain("Tokens");
    expect(target.textContent).not.toContain("attributed");
    // The range control and Export stay.
    expect([...target.querySelectorAll("[aria-label='Range'] [role='tab']")].map((b) => b.textContent)).toEqual(["7d", "30d", "90d"]);
    expect(target.textContent).toContain("Export");
  });

  it("shows the shared loader while the first read is in flight", async () => {
    const target = mountWith(() => new Promise(() => {}));
    await settle();
    expect(target.querySelector("[data-testid='activity-loader']")).toBeTruthy();
    expect(target.querySelector("[data-testid='activity-empty']")).toBeNull();
  });

  it("shows the failed line with Try again, never the empty copy, and retries", async () => {
    const read = vi.fn(async (): Promise<unknown> => failure("http", "HTTP 502 Bad Gateway {\"error\":\"upstream\"}"));
    const target = mountWith(read);
    await settle();
    const failed = target.querySelector("[data-testid='activity-failed']");
    expect(failed?.getAttribute("data-reason")).toBe("server");
    expect(failed?.textContent).toContain("HQ couldn't load activity right now. Try again in a moment.");
    expect(target.textContent).not.toContain("502");
    expect(target.textContent).not.toContain("upstream");
    expect(target.querySelector("[data-testid='activity-sign-in']")).toBeNull();
    expect(target.querySelector("[data-testid='activity-empty']")).toBeNull();
    read.mockImplementation(async () => ok(COMPANY_TELEMETRY));
    target.querySelector<HTMLButtonElement>("[data-testid='activity-retry']")!.click();
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(target.querySelector("[data-testid='activity-failed']")).toBeNull();
  });

  it("says the user is offline when the read could not reach HQ", async () => {
    const target = mountWith(vi.fn(async (): Promise<unknown> => failure("network", "fetch failed: ECONNREFUSED 10.0.0.1:443")));
    await settle();
    const failed = target.querySelector("[data-testid='activity-failed']");
    expect(failed?.getAttribute("data-reason")).toBe("offline");
    expect(failed?.textContent).toContain("You're offline");
    expect(target.textContent).not.toContain("ECONNREFUSED");
    expect(target.querySelector("[data-testid='activity-retry']")).toBeTruthy();
  });

  it("offers Sign in again on an expired sign-in, then reads again", async () => {
    const read = vi.fn(async (): Promise<unknown> => failure("unauthorized", "HTTP 401 Unauthorized"));
    const onsignin = vi.fn(async () => {});
    const target = mountWith(read, onsignin);
    await settle();
    const failed = target.querySelector("[data-testid='activity-failed']");
    expect(failed?.getAttribute("data-reason")).toBe("signed-out");
    expect(failed?.textContent).toContain("Your sign-in has expired. Sign in again to load activity.");
    expect(target.textContent).not.toContain("401");
    read.mockImplementation(async () => ok(COMPANY_TELEMETRY));
    target.querySelector<HTMLButtonElement>("[data-testid='activity-sign-in']")!.click();
    await settle();
    expect(onsignin).toHaveBeenCalledTimes(1);
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

describe("OWNER-R7 Activity team list and member pane", () => {
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
  const body = {
    ...COMPANY_TELEMETRY,
    perMember: [
      { ...COMPANY_TELEMETRY.perMember[1], label: "", efficiency: null, trend: [0, 1] },
      {
        ...COMPANY_TELEMETRY.perMember[0],
        efficiency: 3.75,
        trend: [100, 0, 1500],
        totals: {
          ...COMPANY_TELEMETRY.perMember[0].totals,
          services: { total: 3, byService: [{ service: "github", count: 3 }] },
        },
      },
    ],
  };
  function mountWith(extra: Record<string, unknown> = {}) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(ActivityView, {
      target,
      props: { slug: "acme", companyLabel: "Acme", adapter: { company: { getTeamTelemetry: vi.fn(async () => ok(body)) } } as never, ...extra },
    });
    return target;
  }

  const names = (target: HTMLElement) =>
    [...target.querySelectorAll("[data-testid='activity-member-row'] .who-name")].map((el) => el.textContent?.trim());

  it("sorts by recent activity by default and by name on request", async () => {
    const target = mountWith();
    await settle();
    expect(names(target)).toEqual(["Ada", "Unknown bot"]);
    target.querySelector<HTMLButtonElement>("[data-testid='activity-sort-name']")!.click();
    flushSync();
    expect(names(target)).toEqual(["Ada", "Unknown bot"].sort((a, b) => a.localeCompare(b)));
    expect(target.querySelector("[data-testid='activity-sort-name']")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a real photo when the app has one, initials otherwise", async () => {
    const target = mountWith({ avatarByUid: { prs_a: "https://example.com/ada.png" } });
    await settle();
    const rows = [...target.querySelectorAll<HTMLElement>("[data-testid='activity-member-row']")];
    expect(rows[0].querySelector("[data-testid='activity-member-photo']")?.getAttribute("src")).toBe("https://example.com/ada.png");
    expect(rows[1].querySelector("[data-testid='activity-member-photo']")).toBeNull();
    expect(rows[1].querySelector("[data-testid='activity-member-initials']")).not.toBeNull();
  });

  it("shows one row per person with activity bars, last active and team counts, never ids", async () => {
    const target = mountWith();
    await settle();
    expect([...target.querySelectorAll(".team-head span")].map((el) => el.textContent)).toEqual([
      "Person", "Last 30d", "Last active", "Sessions", "Stories", "PRs", "Deploys",
    ]);
    const rows = [...target.querySelectorAll<HTMLElement>("[data-testid='activity-member-row']")];
    const cells = rows.map((row) => [...row.children].map((el) => el.textContent?.trim()));
    expect(cells[0].slice(1)).toEqual(["", "Today", "5", "3", "1", "2"]);
    expect(names(target)[0]).toBe("Ada");
    expect(names(target)[1]).toBe("Unknown bot");
    expect(rows[0].querySelectorAll("[data-testid='activity-member-bars'] i")).toHaveLength(30);
    expect(rows[1].querySelector("[data-testid='activity-member-initials']")?.classList.contains("bot")).toBe(true);
    expect(target.textContent).not.toMatch(/\b(prs|agt)_/);
  });

  it("opens the member pane with totals, models, skills and tools; Escape closes it", async () => {
    const target = mountWith();
    await settle();
    target.querySelector<HTMLElement>("[data-testid='activity-member-row']")!.click();
    flushSync();
    const pane = target.querySelector("[data-testid='activity-member-pane']");
    expect(pane?.textContent).toContain("Ada");
    expect(pane?.textContent).toContain("ada@example.com");
    expect(pane?.textContent).toContain("run-project");
    expect(pane?.textContent).toContain("github");
    expect(pane?.querySelectorAll(".bars i:not(.idle)").length).toBeGreaterThan(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    flushSync();
    expect(target.querySelector("[data-testid='activity-member-pane']")).toBeNull();
  });

  it("exports PRs alongside what the table shows", () => {
    const csv = activityToCsv(activityFromCompanyTelemetry(body), "30d");
    expect(csv.split("\n")[0]).toContain("prs");
    expect(csv).toContain("3.75");
  });
});
