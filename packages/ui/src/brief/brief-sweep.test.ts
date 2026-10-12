import { describe, expect, it, vi } from "vitest";
import { fleetIncidentOf, parseSweep, redRows, sweepToInput, type BriefSweep } from "./brief-sweep.js";
import { gatherBriefInput, sweepPath, adapterSweepSource, type BriefAdapter, type BriefSweepSource } from "./brief-data.js";
import { octoberEightBrief } from "./brief-fixture.js";
import { generateBrief } from "./brief-generate.js";
import sweepJson from "./fixtures/sweep-2026-10-08.json";

const sweep = sweepJson as unknown as BriefSweep;
const real = () => sweepToInput(sweep, { day: "2026-10-08", companyUid: "cmp_indigo" });

describe("sweepToInput on the real Oct 8 sweep", () => {
  it("carries the day's real PR totals and the window's PRs by repo", () => {
    const s = real();
    expect([s.merged, s.opened]).toEqual([87, 101]);
    expect(s.prWindow).toMatchObject({ from: "2026-10-04", to: "2026-10-08", total: 109, merged: 87 });
    expect(s.prWindow!.byRepo.slice(0, 3)).toEqual([
      { repo: "hq-core-staging", total: 41, merged: expect.any(Number) },
      { repo: "hq-desktop-app", total: 40, merged: expect.any(Number) },
      { repo: "hq-pro", total: 13, merged: expect.any(Number) },
    ]);
    const shippedPrs = s.shipped.reduce((n, x) => n + x.lines.length, 0);
    expect(shippedPrs).toBeGreaterThan(0);
    expect(s.shipped.every((x) => x.origin.repo?.startsWith("indigoai-us/"))).toBe(true);
  });

  it("maps the brief's local date, red main CI and meeting signal counts; the fleet count is not a card", () => {
    const s = real();
    expect(s.today).toBe("2026-10-09");
    expect("fleet" in s).toBe(false);
    expect(s.risks).toEqual([
      expect.objectContaining({ id: "ci:hq-desktop-app", severity: "incident", title: "hq-desktop-app main CI red" }),
    ]);
    const sales = s.meetingsYesterday.find((m) => m.title === "HQ <> Sales Sync")!;
    expect([sales.decisions, sales.actions]).toEqual([3, 9]);
    expect(s.meetingsYesterday.length).toBeGreaterThanOrEqual(5);
  });

  it("leaves the owner out of their own team", () => {
    const team = sweepToInput(sweep, { day: "2026-10-08", companyUid: "cmp_indigo", selfName: "Corey Epstein" }).team;
    expect(team.some((t) => t.name === "Corey")).toBe(false);
  });

  it("labels agt_ DM senders as agents and drops the assistant", () => {
    const team = real().team;
    expect(team.find((t) => t.name === "Izzy")).toMatchObject({ isAgent: true });
    expect(team.find((t) => t.name === "Hassaan")).toMatchObject({ isAgent: false });
    expect(team.some((t) => t.name === "assistant")).toBe(false);
  });

  it("never carries another company's session titles", () => {
    const s = real();
    const other = s.sessions.filter((x) => x.company !== "cmp_indigo");
    expect(other.length).toBeGreaterThan(0);
    expect(other.every((x) => x.title === "")).toBe(true);
  });

  it("rejects text that is not a JSON object", () => {
    expect(parseSweep("nope")).toBeNull();
    expect(parseSweep("[]")).toBeNull();
  });
});

describe("the preview fixture", () => {
  it("is real where the sweep has data and marks the rest as sample", () => {
    const day = octoberEightBrief(new Date(2026, 9, 9, 7, 40));
    expect([day.merged, day.opened]).toEqual([87, 101]);
    expect(day.decisions.every((d) => d.sample)).toBe(true);
    expect(day.waitingOn.every((w) => w.sample)).toBe(true);
    expect(day.calendarSample).toBe(true);
    expect(day.shipped.some((s) => s.sample)).toBe(false);
    expect(day.risks.filter((r) => !r.sample).map((r) => r.id)).toEqual(["ci:hq-desktop-app"]);
  });
});

describe("BriefSweepSource in gatherBriefInput", () => {
  const NOW = new Date(2026, 9, 9, 7, 40);
  const calendarEvent = { id: "e1", summary: "Live standup", start: { dateTime: new Date(2026, 9, 9, 9).toISOString() }, end: {}, status: "confirmed" };
  const adapter = (): BriefAdapter => ({
    identity: { whoami: async () => ({ ok: true as const, value: { personUid: "prs_me", email: "c@getindigo.ai", displayName: "Corey" } }) },
    meetings: { listUpcoming: async () => ({ ok: true as const, value: [calendarEvent] }) },
  });
  const companies = [{ uid: "cmp_indigo", slug: "indigo", label: "Indigo" }];

  it("reads workspace/brief/<date>/brief-data.json and merges it under the adapter", async () => {
    const reads: string[] = [];
    const source: BriefSweepSource = {
      readHqFile: async (path) => {
        reads.push(path);
        return JSON.stringify(sweepJson);
      },
    };
    const { input } = await gatherBriefInput(adapter(), { now: NOW, companies, sweep: source, log: () => {} });
    expect(reads).toEqual(["workspace/brief/2026-10-09/brief-data.json"]);
    expect(sweepPath(NOW)).toBe("workspace/brief/2026-10-09/brief-data.json");
    // Adapter wins for the calendar; the sweep fills the rest.
    expect(input.calendarToday.map((e) => e.title)).toEqual(["Live standup"]);
    expect([input.merged, input.opened]).toEqual([87, 101]);
    expect(input.today).toBe("2026-10-09");
    expect(input.risks.map((r) => r.id)).toEqual(["ci:hq-desktop-app"]);
    expect(input.shipped.length).toBeGreaterThan(0);
  });

  it("renders from the adapter alone when the file is absent", async () => {
    const { input, failures } = await gatherBriefInput(adapter(), {
      now: NOW,
      companies,
      sweep: { readHqFile: async () => null },
      log: () => {},
    });
    expect(input.merged).toBeNull();
    expect(input.today).toBe("2026-10-09");
    expect(failures).not.toContain("sweep");
  });

  it("logs an unreadable or invalid sweep instead of swallowing it", async () => {
    const log = vi.fn();
    const bad = await gatherBriefInput(adapter(), { now: NOW, companies, sweep: { readHqFile: async () => "{oops" }, log });
    expect(bad.failures).toContain("sweep");
    const thrown = await gatherBriefInput(adapter(), {
      now: NOW,
      companies,
      sweep: { readHqFile: async () => Promise.reject(new Error("denied")) },
      log,
    });
    expect(thrown.failures).toContain("sweep");
    expect(log).toHaveBeenCalledWith("sweep failed", "denied");
  });

  it("defaults to the adapter's HQ file read", async () => {
    const getFileContent = vi.fn(async () => ({ ok: true as const, value: JSON.stringify(sweepJson) }));
    const { input } = await gatherBriefInput({ ...adapter(), files: { getFileContent } }, { now: NOW, companies, log: () => {} });
    expect(getFileContent).toHaveBeenCalledWith("workspace/brief/2026-10-09/brief-data.json");
    expect(input.merged).toBe(87);
    expect(adapterSweepSource(null)).toBeNull();
  });
});

describe("sweepToInput on a newer sweep", () => {
  const newer: BriefSweep = {
    generated_at: "2026-10-11T14:00:00Z",
    company: "indigo",
    window: { from: "2026-10-10", to: "2026-10-11", today: "2026-10-11" },
    prs: [
      { repo: "hq-core-staging", product: "HQ core", number: 1, title: "fix(gate): retry", state: "merged", created: "2026-10-10T10:00:00Z", closed: "2026-10-10T12:00:00Z", merge_hours: 2 },
      { repo: "hq-core-staging", product: "HQ core", number: 2, title: "feat(gate): wait", state: "merged", created: "2026-10-10T10:00:00Z", closed: "2026-10-10T20:00:00Z", merge_hours: 10 },
      { repo: "hq-core-staging", number: 3, title: "open one", state: "open", created: "2026-10-10T18:00:00Z", closed: null },
    ],
    main_health: {
      "hq-core-staging": {
        workflows: 6,
        red: [
          { workflow: "Promote", since: "2026-10-09T14:00:00Z", merges_on_top: 4 },
          { workflow: "Gate", since: "2026-10-10T14:00:00Z", merges_on_top: 1 },
        ],
        delta: { newly_red: ["Gate"], still_red: ["Promote"], recovered: [] },
      },
      "hq-pro": { workflows: 4, red: [] },
      "hq-cloud": { workflows: 3, red: ["Sync nightly"] },
    },
    releases: [
      {
        product: "Desktop app",
        repo: "hq-desktop-app",
        version: "0.11.3",
        merged_at: "2026-10-10T21:13:12Z",
        pending_count: 4,
        pending_by_day: [{ day: "2026-10-11", count: 3, theme: "onboarding" }, { day: "2026-10-10", count: 1 }],
      },
    ],
    sessions: [
      {
        id: "s-1",
        date: "2026-10-10",
        time: "09:33",
        company: "indigo",
        title: "Fix the gate",
        kind: "you",
        started_at: "2026-10-10T15:33:29Z",
        project: "hq-core-staging",
        product: "HQ core",
        end: "2026-10-10T16:10:00Z",
        has_handoff: true,
      },
      { id: "s-2", date: "2026-10-10", time: "10:00", company: "other", title: null, kind: "you", started_at: "2026-10-10T16:00:00Z", project: "secret", product: "Secret" },
      { date: "2026-10-10", time: "11:00", company: "indigo", title: "Background", kind: "agent" },
    ],
  };
  const s = sweepToInput(newer, { day: "2026-10-10", companyUid: "cmp_indigo" });

  it("maps main_health rows with since, merges on top and the delta, for every repo", () => {
    expect(s.mainHealth).toEqual([
      {
        repo: "hq-core-staging",
        product: "HQ core",
        companyUid: "cmp_indigo",
        workflows: 6,
        red: [
          { workflow: "Promote", since: "2026-10-09T14:00:00Z", mergesOnTop: 4 },
          { workflow: "Gate", since: "2026-10-10T14:00:00Z", mergesOnTop: 1 },
        ],
        delta: { newlyRed: ["Gate"], stillRed: ["Promote"], recovered: [] },
      },
      { repo: "hq-pro", product: "HQ Pro", companyUid: "cmp_indigo", workflows: 4, red: [] },
      { repo: "hq-cloud", product: "HQ Cloud", companyUid: "cmp_indigo", workflows: 3, red: [{ workflow: "Sync nightly", since: null, mergesOnTop: null }] },
    ]);
  });

  it("a red main is an incident with the earliest since, its age at sweep time and the merges on top", () => {
    expect(s.risks.map((r) => r.id)).toEqual(["ci:hq-core-staging", "ci:hq-cloud"]);
    expect(s.risks[0]!.ci).toEqual({
      repo: "hq-core-staging",
      workflow: "Promote +1 more",
      job: null,
      since: "2026-10-09T14:00:00.000Z",
      ageHours: 48,
      note: "2 of 6 workflows red on main.",
      mergesOnTop: 4,
    });
    expect(s.risks[1]!.ci).toMatchObject({ repo: "hq-cloud", workflow: "Sync nightly", since: null, ageHours: null });
    expect("mergesOnTop" in s.risks[1]!.ci!).toBe(false);
  });

  it("shipped rollups carry the product and the median merge hours; open rows with a null close still count", () => {
    expect(s.shipped).toHaveLength(1);
    expect(s.shipped[0]).toMatchObject({ id: "ship:hq-core-staging", status: "2 merged", note: "1 open", origin: { product: "HQ core" }, mergeHoursMedian: 6 });
    expect([s.merged, s.opened]).toEqual([2, 3]);
  });

  it("maps releases with pending days oldest first", () => {
    expect(s.releases).toEqual([
      {
        product: "Desktop app",
        version: "0.11.3",
        origin: { companyUid: "cmp_indigo", repo: "indigoai-us/hq-desktop-app", product: "Desktop app" },
        releasedAt: "2026-10-10T21:13:12Z",
        pending: [
          { day: "2026-10-10", count: 1, theme: "" },
          { day: "2026-10-11", count: 3, theme: "onboarding" },
        ],
        pendingCount: 4,
        held: [],
        light: "ok",
      },
    ]);
  });

  it("sessions keep project, product, end and handoff inside the sweep's company only", () => {
    expect(s.sessions).toEqual([
      {
        id: "s-1",
        title: "Fix the gate",
        startedAt: "2026-10-10T15:33:29Z",
        workstream: "Work",
        company: "cmp_indigo",
        project: "hq-core-staging",
        product: "HQ core",
        endedAt: "2026-10-10T16:10:00Z",
        hasHandoff: true,
      },
      { id: "s-2", title: "", startedAt: "2026-10-10T16:00:00Z", workstream: "Other", company: "other" },
    ]);
  });

  it("without fleet data there is no fleet incident and never a fleet count", () => {
    expect("fleetIncident" in s).toBe(false);
    expect("fleet" in s).toBe(false);
  });

  it("redRows accepts names or rows and drops blanks", () => {
    expect(redRows(["CI", "", { workflow: " Gate ", since: "2026-10-10T00:00:00Z", merges_on_top: 2 }, { workflow: "" }])).toEqual([
      { workflow: "CI", since: null, mergesOnTop: null },
      { workflow: "Gate", since: "2026-10-10T00:00:00Z", mergesOnTop: 2 },
    ]);
    expect(redRows(undefined)).toEqual([]);
  });
});

describe("fleetIncidentOf", () => {
  const origin = { companyUid: "cmp_indigo", repo: null };
  const now = "2026-10-11T14:00:00Z";
  const stuck = (name: string, phase = "waiting", since: string | null = null) => ({ name, status: "provisioning", phase, since });

  it("is null when nothing is stuck, nothing recovered and the series is quiet for a day", () => {
    expect(fleetIncidentOf(null, now, origin)).toBeNull();
    expect(fleetIncidentOf({ total: 10, stuck: [], series: [{ generated_at: "2026-10-09T14:00:00Z", stuck: 2 }] }, now, origin)).toBeNull();
    expect(fleetIncidentOf({ total: 10, by_status: { active: 10 } }, now, origin)).toBeNull();
  });

  it("healing when the stuck count fell since the previous run", () => {
    const fi = fleetIncidentOf(
      { total: 50, stuck: [stuck("agent-b", "waiting", "2026-10-09T12:00:00Z"), stuck("agent-a", "failed")], delta: { still_stuck: ["agent-a", "agent-b"], recovered: ["agent-c"] }, series: [{ generated_at: "2026-10-10T14:00:00Z", stuck: 3 }] },
      now,
      origin,
    )!;
    expect(fi).toMatchObject({ id: "fleet:cmp_indigo", verdict: "healing", incidentStart: "2026-10-09T12:00:00.000Z", incidentEnd: null, fixes: [] });
    expect(fi.stillStuck).toEqual([
      { name: "agent-a", reason: "setup failed", since: null },
      { name: "agent-b", reason: "waiting in setup", since: "2026-10-09T12:00:00Z" },
    ]);
    expect(fi.series).toEqual([
      { at: "2026-10-10T14:00:00Z", stuck: 3 },
      { at: now, stuck: 2 },
    ]);
  });

  it("relapsing when agents got stuck again after the count had fallen", () => {
    const fi = fleetIncidentOf(
      {
        total: 50,
        stuck: [stuck("x"), stuck("y"), stuck("z")],
        delta: { newly_stuck: ["y", "z"], still_stuck: ["x"], recovered: [] },
        series: [
          { generated_at: "2026-10-09T14:00:00Z", stuck: 5 },
          { generated_at: "2026-10-10T14:00:00Z", stuck: 1 },
        ],
      },
      now,
      origin,
    )!;
    expect(fi.verdict).toBe("relapsing");
    expect(fi.incidentStart).toBe("2026-10-09T14:00:00Z");
  });

  it("plateaued when the count is flat or there is no history", () => {
    expect(fleetIncidentOf({ total: 50, stuck: [stuck("x"), stuck("y")], series: [{ generated_at: "2026-10-10T14:00:00Z", stuck: 2 }] }, now, origin)!.verdict).toBe("plateaued");
    expect(fleetIncidentOf({ total: 50, stuck: [stuck("x")] }, now, origin)!.verdict).toBe("plateaued");
  });

  it("healed under two percent or when nobody is left stuck; a healed incident ended at sweep time", () => {
    expect(fleetIncidentOf({ total: 100, stuck: [stuck("x")], series: [{ generated_at: "2026-10-10T14:00:00Z", stuck: 4 }] }, now, origin)!.verdict).toBe("healed");
    const done = fleetIncidentOf({ total: 50, stuck: [], delta: { recovered: ["x", "y"] } }, now, origin)!;
    expect(done).toMatchObject({ verdict: "healed", incidentEnd: now, stillStuck: [] });
    expect(done.series).toEqual([{ at: now, stuck: 0 }]);
  });

  it("falls back to agents outside the ready phase in older sweeps", () => {
    const fi = fleetIncidentOf(
      { total: 3, agents: [{ name: "A", status: "active", phase: "ready" }, { name: "C", status: "provisioning", phase: "failed" }, { name: "B", status: "provisioning", phase: "waiting" }] },
      now,
      origin,
    )!;
    expect(fi.stillStuck.map((a) => [a.name, a.reason])).toEqual([
      ["B", "waiting in setup"],
      ["C", "setup failed"],
    ]);
    expect(fi.verdict).toBe("plateaued");
  });
});

describe("sweepToInput on an Oct 11-shaped sweep: the 24h PR window and prs_summary", () => {
  const NOW = "2026-10-11T14:54:49Z";
  const PRODUCTS: [string, string][] = [
    ["hq-pro", "HQ Pro"],
    ["hq-desktop-app", "Desktop app"],
    ["hq-packages", "Skill packs"],
    ["hq-cli", "HQ command line"],
    ["hq-core-staging", "HQ core"],
    ["hq-cloud", "HQ Cloud"],
    ["hq-finance", "Finance dashboard"],
  ];
  let n = 0;
  const pr = (repo: string, state: "merged" | "open", created: string, closed: string | null, extra: Partial<NonNullable<BriefSweep["prs"]>[number]> = {}) => {
    n += 1;
    const product = PRODUCTS.find(([r]) => r === repo)?.[1] ?? null;
    return { repo, product, number: n, title: `feat(x): change ${n}`, state, created, closed, authored_by_me: true, ...extra };
  };
  /** 23 of the owner's merges inside Oct 10 14:54Z..Oct 11 14:54Z (9, 6, 2, 2, 2, 1, 1 by product), 29 merged before it, one reviewer merge inside it, 6 open. */
  function sweepOct11(): BriefSweep {
    n = 0;
    const perProduct = [9, 6, 2, 2, 2, 1, 1];
    const prs: NonNullable<BriefSweep["prs"]> = [];
    PRODUCTS.forEach(([repo], i) => {
      for (let k = 0; k < perProduct[i]!; k += 1) {
        // Evening-local merges land after 00:00Z on the brief's date; the rest earlier inside the window.
        const closed = k % 2 ? `2026-10-11T0${k % 10}:30:00Z` : `2026-10-10T2${k % 4}:15:00Z`;
        prs.push(pr(repo, "merged", "2026-10-10T16:00:00Z", closed, { merge_hours: 2 + k }));
      }
    });
    for (let k = 0; k < 29; k += 1) prs.push(pr(PRODUCTS[k % 7]![0], "merged", "2026-10-09T10:00:00Z", k < 15 ? "2026-10-09T18:00:00Z" : "2026-10-10T12:00:00Z"));
    prs.push(pr("hq-pro", "merged", "2026-10-10T18:00:00Z", "2026-10-11T02:00:00Z", { authored_by_me: false }));
    for (let k = 0; k < 6; k += 1) prs.push(pr("hq-desktop-app", "open", "2026-10-11T14:51:32Z", "0001-01-01T00:00:00Z"));
    return {
      generated_at: NOW,
      company: "indigo",
      window: {
        from: "2026-10-09",
        to: "2026-10-10",
        today: "2026-10-11",
        sessions_from: "2026-10-10T14:54:49+00:00",
        sessions_to: "2026-10-11T14:54:49+00:00",
        hours: 24,
        prs_from: "2026-10-10T14:54:49+00:00",
        prs_to: "2026-10-11T14:54:49+00:00",
      },
      prs,
      prs_summary: { merged: 23, opened: 18, open: 6, review_requested: 0 },
    };
  }
  const opts = { day: "2026-10-10", companyUid: "cmp_indigo" };

  it("merged and opened are the writer's prs_summary numbers, never the search reach: 23, not 52", () => {
    const s = sweepToInput(sweepOct11(), opts);
    expect([s.merged, s.opened]).toEqual([23, 18]);
  });

  it("without prs_summary the same 24h window over the owner's own PRs gives the same merged count", () => {
    const sweep = sweepOct11();
    delete sweep.prs_summary;
    const s = sweepToInput(sweep, opts);
    expect(s.merged).toBe(23);
    // Opened: the 23 window merges were created inside it, plus the 6 open rows; the reviewer's row is not his.
    expect(s.opened).toBe(29);
  });

  it("shipped rollups take the same window, so a merge closed after 00:00Z on the brief's date still counts and the reason sentence agrees", () => {
    const s = sweepToInput(sweepOct11(), opts);
    expect(s.shipped.map((x) => [x.title, x.lines.length])).toEqual([
      ["hq-pro", 9],
      ["hq-desktop-app", 6],
      ["hq-cli", 2],
      ["hq-core-staging", 2],
      ["hq-packages", 2],
      ["hq-cloud", 1],
      ["hq-finance", 1],
    ]);
    expect(s.shipped.reduce((t, x) => t + x.lines.length, 0)).toBe(s.merged);
    expect(s.shipped[0]!.status).toBe("9 merged");
    expect(s.prWindow).toMatchObject({ from: "2026-10-10", to: "2026-10-11", merged: 24 });
    const base = octoberEightBrief(new Date(NOW));
    const plan = generateBrief({ ...base, ...s, now: NOW, decisions: [], risks: [], team: [], meetingsYesterday: [], waitingOn: [], priorities: [] });
    expect(plan.widgets.find((w) => w.kind === "shipped")!.reason).toBe("Shown because you merged 23 changes across 7 products yesterday.");
  });

  it("an older sweep without a PR window keeps the search-reach counts", () => {
    const s = real();
    expect([s.merged, s.opened]).toEqual([87, 101]);
  });
});

describe("sweepToInput never throws on a row the sweep writes without its fields", () => {
  const base: BriefSweep = { generated_at: "2026-10-11T14:00:00Z", company: "indigo", window: { from: "2026-10-10", to: "2026-10-11", today: "2026-10-11" } };

  it("skips a meeting_signals error row (no start, no counts) and reads missing counts as zero", () => {
    const s = sweepToInput(
      {
        ...base,
        meeting_signals: [
          { meeting: "Broken call", error: "timeout" },
          { meeting: "Standup", start: "2026-10-10T15:00:00Z" },
          { meeting: "Planning", start: "2026-10-10T17:00:00Z", counts: { decision: 2, action_item: 1 } },
        ],
      },
      { day: "2026-10-10", companyUid: "cmp_indigo" },
    );
    expect(s.meetingsYesterday.map((m) => [m.title, m.decisions, m.actions])).toEqual([
      ["Planning", 2, 1],
      ["Standup", 0, 0],
    ]);
  });

  it("skips a DM row with a null sender", () => {
    const s = sweepToInput(
      { ...base, dms: [{ from: null, at: "2026-10-10T15:00:00Z" }, { from: "Geoff Hale", from_uid: "prs_geoff", at: "2026-10-10T16:00:00Z" }] },
      { day: "2026-10-10", companyUid: "cmp_indigo" },
    );
    expect(s.team.map((t) => t.name)).toEqual(["Geoff"]);
    expect(s.dmCount).toBe(2);
  });
});
