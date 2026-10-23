import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyRunItems,
  baseInput,
  calendarToday,
  configureBriefSeed,
  foldMainHealth,
  gatherBriefInput,
  mergeMeetings,
  mergeReleases,
  mergeShipped,
  mergeTeam,
  signalsByKind,
  type BriefAdapter,
} from "./brief-data.js";
import { parseBriefItems } from "./brief-run-files.js";
import { rowMerged, shippedTiles } from "./brief-distill.js";
import { octoberEightBrief } from "./brief-fixture.js";
import type { BriefDecision, BriefMeeting, BriefRelease, BriefRisk, BriefShipped, BriefTeammate } from "./brief-types.js";

const NOW = new Date(2026, 9, 8, 7, 40);
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).toISOString();
const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
const err = (code: string) => Promise.resolve({ ok: false as const, reason: "error" as const, code });

function fakeAdapter(): BriefAdapter & { bodies: string[] } {
  const bodies: string[] = [];
  return {
    bodies,
    identity: { whoami: () => ok({ personUid: "prs_me", email: "corey@getindigo.ai", displayName: "Corey Epstein" }) },
    meetings: {
      listUpcoming: () =>
        ok([
          { id: "e1", summary: "Dev standup", start: { dateTime: at(8, 9) }, end: { dateTime: at(8, 9, 30) }, status: "confirmed" },
          {
            id: "e2",
            summary: "Zach and Jeff onboarding",
            start: { dateTime: at(8, 10) },
            end: { dateTime: at(8, 11) },
            status: "confirmed",
            attendees: [{ email: "corey@getindigo.ai" }, { email: "zach@acme.com" }],
          },
          { id: "e3", summary: "Cut30 office hours", start: { dateTime: at(8, 13) }, end: { dateTime: at(8, 14) }, status: "confirmed" },
          { id: "e4", summary: "Tomorrow thing", start: { dateTime: at(9, 9) }, end: { dateTime: at(9, 10) }, status: "confirmed" },
          { id: "e5", summary: "Cancelled", start: { dateTime: at(8, 15) }, end: { dateTime: at(8, 16) }, status: "cancelled" },
        ]),
      listRecorded: (companyId) =>
        companyId === "cmp_indigo"
          ? ok({
              meetings: [
                { meetingId: "m1", title: "Sales sync", startTime: at(7, 9), hasSignals: true, companyId: "cmp_indigo" },
                { meetingId: "m0", title: "Last week", startTime: at(1, 9), hasSignals: true, companyId: "cmp_indigo" },
              ],
            })
          : err("http-500"),
      getRecorded: () =>
        ok({
          signals: {
            decision: [{ presigned_url: "u-d1" }, { presigned_url: "u-d2" }],
            action_item: [{ presigned_url: "u-a1" }],
            question: [{ presigned_url: "u-q1" }],
            risk: [{ title: "Pipeline thin in Q4" }],
            summary: [{ presigned_url: "u-s" }],
          },
        }),
      readRecordedBody: (url) => {
        bodies.push(url);
        return ok(
          url === "u-q1"
            ? "---\ntype: question\n---\n# Question\nKeep the no-self-merge rule? It slows every PR."
            : "---\ntype: action\n---\nSend Jacob the memo folder.",
        );
      },
    },
    notifications: {
      fetchDmThreads: () =>
        ok({
          threads: [
            { peerUid: "prs_izzy", peerName: "Izzy Park", lastActivityAt: at(7, 15) },
            { peerUid: "prs_hassaan", peerName: "Hassaan Ali", lastActivityAt: at(7, 16), lastFromSelf: true },
            { peerUid: "prs_old", peerName: "Old Thread", lastActivityAt: at(1, 16) },
          ],
        }),
    },
    agents: {
      listLocalSessions: () =>
        ok({
          total: 2,
          rows: [
            { sessionId: "s1", startedAt: at(7, 13, 40), company: "indigo", project: "hq-core", title: "Bot parity" },
            { sessionId: "s2", startedAt: at(7, 14), company: "acme", project: "acme-secret", title: "Acme pricing" },
          ],
        }),
    },
  };
}

const companies = [
  { uid: "cmp_indigo", slug: "indigo", label: "Indigo" },
  { uid: "cmp_liverecover", slug: "liverecover", label: "LiveRecover" },
];

afterEach(() => configureBriefSeed(null));

describe("gatherBriefInput", () => {
  it("maps every live source into the brief input", async () => {
    const log = vi.fn();
    const { input, failures } = await gatherBriefInput(fakeAdapter(), { now: NOW, companies, log, lastBriefAt: null });
    expect(input.userName).toBe("Corey");
    expect(input.calendarToday.map((e) => [e.title, e.kind])).toEqual([
      ["Dev standup", "team"],
      ["Zach and Jeff onboarding", "ext"],
      ["Cut30 office hours", "learn"],
    ]);
    expect(input.meetingsYesterday).toEqual([
      expect.objectContaining({ id: "m1", title: "Sales sync", decisions: 2, actions: 1, risks: 1, questions: 1 }),
    ]);
    expect(input.decisions).toEqual([
      expect.objectContaining({ title: "Keep the no-self-merge rule?", action: "decide", origin: { companyUid: "cmp_indigo", repo: "Sales sync" } }),
    ]);
    expect(input.actionItems.map((a) => a.title)).toEqual(["Send Jacob the memo folder."]);
    expect(input.risks).toEqual([expect.objectContaining({ title: "Pipeline thin in Q4", severity: "watch" })]);
    expect(input.team.map((t) => t.name)).toEqual(["Izzy", "Hassaan"]);
    expect(input.waitingOn).toEqual([{ id: "prs_hassaan", who: "Hassaan", what: "to reply to your DM" }]);
    expect(input.dmCount).toBe(2);
    expect(input.sessions.map((s) => s.company)).toEqual(["indigo", "acme"]);
    expect(input.companies).toEqual(["cmp_indigo", "indigo", "cmp_liverecover", "liverecover"]);
    expect(input.shipped).toEqual([]);
    // The second company's list failed: logged and recorded, not swallowed.
    expect(failures).toEqual(["meetings LiveRecover"]);
    expect(log).toHaveBeenCalledWith("meetings LiveRecover failed", "meetings LiveRecover: error (http-500)");
  });

  it("still returns a brief when every source is missing or failing", async () => {
    const log = vi.fn();
    const broken: BriefAdapter = {
      identity: { whoami: () => err("http-401") },
      meetings: { listUpcoming: () => Promise.reject(new Error("offline")) },
      notifications: null,
    };
    const { input, failures } = await gatherBriefInput(broken, { now: NOW, companies, log });
    expect([...failures].sort()).toEqual(["calendar", "dm threads", "identity", "meetings", "sessions"]);
    expect(log).toHaveBeenCalledTimes(5);
    expect(input.calendarToday).toEqual([]);
    expect(input.decisions).toEqual([]);
    expect(input.userName).toBe("");
  });

  it("caps signal body reads", async () => {
    const adapter = fakeAdapter();
    await gatherBriefInput(adapter, { now: NOW, companies, log: () => {} });
    expect(adapter.bodies.length).toBeLessThanOrEqual(10);
    expect(adapter.bodies).not.toContain("u-s");
  });

  it("a source that never answers counts as failed after the timeout, and the rest still render", async () => {
    const log = vi.fn();
    const adapter = fakeAdapter();
    adapter.notifications = { fetchDmThreads: () => new Promise(() => {}) };
    const started = Date.now();
    const { input, failures } = await gatherBriefInput(adapter, { now: NOW, companies, log, sourceTimeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(failures).toContain("dm threads");
    expect(log).toHaveBeenCalledWith("dm threads failed", "dm threads: no answer in 30 ms");
    expect(input.team).toEqual([]);
    expect(input.userName).toBe("Corey");
    expect(input.meetingsYesterday).toHaveLength(1);
  });

  it("reads every company's meetings at the same time, not one after another", async () => {
    const adapter = fakeAdapter();
    const inFlight: string[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    adapter.meetings!.listRecorded = async (companyId) => {
      inFlight.push(companyId ?? "");
      if (inFlight.length === companies.length) release?.();
      await gate;
      return { ok: true as const, value: { meetings: [] } };
    };
    const pending = gatherBriefInput(adapter, { now: NOW, companies, log: () => {}, sourceTimeoutMs: 5_000 });
    await gate;
    expect(inFlight).toEqual(["cmp_indigo", "cmp_liverecover"]);
    const { input } = await pending;
    expect(input.meetingsYesterday).toEqual([]);
  });

  it("with live off, reads only the run files and touches no adapter source", async () => {
    const adapter = fakeAdapter();
    const calendar = vi.spyOn(adapter.meetings!, "listUpcoming");
    const recorded = vi.spyOn(adapter.meetings!, "listRecorded");
    const dms = vi.spyOn(adapter.notifications!, "fetchDmThreads");
    const reads: string[] = [];
    const sweep = {
      readHqFile: async (p: string) => {
        reads.push(p);
        if (p.endsWith("brief.json")) return JSON.stringify({ items: { decisions: [{ id: "d1", title: "Stored call" }] } });
        if (p.endsWith("brief-data.json")) return "{}";
        return null;
      },
    };
    const { input, failures } = await gatherBriefInput(adapter, { now: NOW, companies, log: () => {}, live: false, sweep, runId: "brief-20261008-070000" });
    expect(calendar).not.toHaveBeenCalled();
    expect(recorded).not.toHaveBeenCalled();
    expect(dms).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
    expect(reads).toContain("workspace/brief/brief-20261008-070000/brief.json");
    expect(input.decisions.map((d) => d.title)).toEqual(["Stored call"]);
    expect(input.userName).toBe("");
  });

  it("serves the seed instead of the adapter when one is configured", async () => {
    configureBriefSeed(() => octoberEightBrief(NOW));
    const adapter = fakeAdapter();
    const spy = vi.spyOn(adapter.meetings!, "listUpcoming");
    const { input } = await gatherBriefInput(adapter, { now: NOW, companies });
    expect(input.decisions).toHaveLength(4);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("parsers", () => {
  it("drops events without a timed start today", () => {
    expect(calendarToday([{ id: "x", summary: "All day", start: { date: "2026-10-08" }, end: {} }], NOW, "a@b.c")).toEqual([]);
  });

  it("groups signal types and ignores unknown ones", () => {
    const out = signalsByKind({ signals: { decisions: [{}], key_point: [{}], risks: [{}, {}] } });
    expect([out.decisions.length, out.risks.length, out.actions.length]).toEqual([1, 2, 0]);
  });
});

describe("mergePastMeetings", () => {
  it("puts only the signed-in person's own recordings on the Today row, never a teammate's", async () => {
    // hq-pro's recorded list is ACL-filtered: an owner or admin reads every
    // member's recordings. Owner report: the Today row listed teammates' calls.
    const a = fakeAdapter();
    a.meetings!.listUpcoming = () => ok([]);
    a.meetings!.listScheduledBots = () => ok([{ botId: "m_mine" }]);
    a.meetings!.listRecorded = (companyId) =>
      companyId === "cmp_indigo"
        ? ok({
            meetings: [
              { meetingId: "m_mine", title: "My 1:1", startTime: at(8, 6), hasSignals: false, companyId: "cmp_indigo" },
              { meetingId: "m_team1", title: "HQ GTM Sync", startTime: at(8, 6, 30), hasSignals: false, companyId: "cmp_indigo" },
              { meetingId: "m_team2", title: "Jake Estep", startTime: at(8, 7), hasSignals: false, companyId: "cmp_indigo" },
            ],
          })
        : ok({ meetings: [] });
    const { input } = await gatherBriefInput(a, { companies, now: NOW, log: () => {} });
    expect(input.calendarToday.map((e) => e.title)).toEqual(["My 1:1"]);
  });

  it("shows an empty Today row when no calendar is connected and no own recording exists", async () => {
    const a = fakeAdapter();
    a.meetings!.listUpcoming = () => err("not-connected");
    a.meetings!.listScheduledBots = () => ok([]);
    a.meetings!.listRecorded = () =>
      ok({ meetings: [{ meetingId: "m_team", title: "HQ Dev Standup", startTime: at(8, 6), hasSignals: false, companyId: "cmp_indigo" }] });
    const { input, failures } = await gatherBriefInput(a, { companies, now: NOW, log: () => {} });
    expect(input.calendarToday).toEqual([]);
    expect(failures).toContain("calendar");
  });

  it("adds today's earlier recorded calls the calendar feed no longer lists, once", async () => {
    const { mergePastMeetings } = await import("./brief-data.js");
    const now = new Date("2026-10-09T21:00:00Z");
    const cal = [{ id: "c1", title: "Standup", start: "2026-10-09T16:00:00Z", kind: "team" as const }];
    const rec = [
      { id: "r1", title: "standup", start: "2026-10-09T16:05:00Z", kind: "team" as const },
      { id: "r2", title: "Jacob / Amir", start: "2026-10-09T15:00:00Z", kind: "team" as const },
      { id: "r3", title: "Later", start: "2026-10-09T23:00:00Z", kind: "team" as const },
    ];
    expect(mergePastMeetings(cal, rec, now).map((e) => e.id)).toEqual(["r2", "c1"]);
  });
});

// ---------------------------------------------------------------------------
// Row-level folds between the sweep and the writer. Pure.
// ---------------------------------------------------------------------------

const INDIGO = "cmp_indigo";
const ciRisk = (repo: string, workflow: string, extra: Partial<NonNullable<BriefRisk["ci"]>> = {}): BriefRisk => ({
  id: `ci:${repo}`,
  title: `${repo} main CI red`,
  summary: `${workflow} failing on main.`,
  severity: "incident",
  links: [],
  origin: { companyUid: INDIGO, repo: `indigoai-us/${repo}` },
  ci: { repo, workflow, job: null, since: null, ageHours: null, note: null, ...extra },
});
const decision = (id: string, extra: Partial<BriefDecision>): BriefDecision => ({
  id,
  title: id,
  summary: id,
  action: "decide",
  origin: { companyUid: INDIGO, repo: null },
  ...extra,
});
const rollup = (repo: string, merged: number, product?: string): BriefShipped => ({
  id: `ship:${repo}`,
  title: repo,
  status: `${merged} merged`,
  note: "nothing open",
  origin: { companyUid: INDIGO, repo: `indigoai-us/${repo}`, ...(product ? { product } : {}) },
  lines: Array.from({ length: merged }, (_, i) => ({ label: `${i} change`, state: "MERGED" })),
});
const writerShip = (id: string, title: string, product: string, extra: Partial<BriefShipped> = {}): BriefShipped => ({
  id,
  title,
  status: "",
  note: "",
  origin: { companyUid: INDIGO, repo: null, product },
  lines: [],
  ...extra,
});

describe("foldMainHealth", () => {
  const writerIncident: BriefRisk = {
    id: "p1",
    title: "Fix the failing nightly check",
    summary: "",
    severity: "incident",
    links: [],
    origin: { companyUid: INDIGO, repo: null, product: "HQ Cloud" },
    ci: { repo: "HQ Cloud", workflow: null, job: null, since: null, ageHours: 48, note: "Two days red" },
  };

  it("drops the sweep row the writer covers by repo (decision) or by product (incident), and keeps the rest", () => {
    const risks = [writerIncident, ciRisk("hq-core-staging", "Promote", { since: "2026-10-09T14:00:00Z", mergesOnTop: 4 }), ciRisk("hq-cloud", "Sync nightly"), ciRisk("hq-pro", "pr-checks")];
    const decisions = [decision("d3", { source: "main_health", origin: { companyUid: INDIGO, repo: "hq-core-staging", product: "HQ core" } })];
    const out = foldMainHealth(risks, decisions);
    expect(out.map((r) => r.id)).toEqual(["p1", "ci:hq-pro"]);
    // The writer's row keeps its own facts and gains the sweep's where it had none.
    expect(out[0]!.ci).toEqual({ repo: "hq-cloud", workflow: "Sync nightly", job: null, since: null, ageHours: 48, note: "Two days red" });
    expect(out[0]).not.toBe(writerIncident);
  });

  it("a decision from another source on the same repo does not fold the red main away", () => {
    const risks = [ciRisk("hq-core-staging", "Promote")];
    const out = foldMainHealth(risks, [decision("d1", { source: "dms", origin: { companyUid: INDIGO, repo: "hq-core-staging" } })]);
    expect(out.map((r) => r.id)).toEqual(["ci:hq-core-staging"]);
  });

  it("is a copy when nothing folds", () => {
    const risks = [writerIncident];
    const out = foldMainHealth(risks, []);
    expect(out).toEqual(risks);
    expect(out).not.toBe(risks);
  });
});

describe("mergeShipped", () => {
  const rollups = [rollup("hq-cli", 3), rollup("hq-pro", 2, "HQ Pro")];

  it("folds a plain product row onto its rollup (by repo or product) and keeps a named ship as its own row", () => {
    const out = mergeShipped(rollups, [
      writerShip("s1", "HQ command line", "HQ command line", { first: true, why: "Colors landed.", highlights: ["Colors in the CLI", "colors in the cli"], mergeHoursMedian: 4, origin: { companyUid: INDIGO, repo: "hq-cli", product: "HQ command line" } }),
      writerShip("s2", "Pro 2.0 is out", "HQ Pro", { first: true, why: "The release finished." }),
      writerShip("s3", "Finance dashboard", "Finance dashboard", { first: true }),
    ]);
    expect(out.map((s) => s.id)).toEqual(["ship:hq-cli", "ship:hq-pro", "s2", "s3"]);
    expect(out[0]).toMatchObject({ first: true, why: "Colors landed.", highlights: ["Colors in the CLI"], mergeHoursMedian: 4, origin: { product: "HQ command line" } });
    expect(out[0]!.lines).toHaveLength(3);
    expect(out[1]).toMatchObject({ why: "The release finished." });
    expect(out[1]!.first).toBeUndefined();
    expect(out.filter((s) => s.first).map((s) => s.id)).toEqual(["ship:hq-cli", "s2", "s3"]);
    // Inputs are not mutated.
    expect(rollups[0]!.first).toBeUndefined();
    expect(rollups[0]!.origin.product).toBeUndefined();
  });

  it("without rollups the writer rows stand alone", () => {
    expect(mergeShipped([], [writerShip("s1", "Desktop app", "Desktop app")]).map((s) => s.id)).toEqual(["s1"]);
    expect(mergeShipped(rollups, [])).toEqual(rollups);
  });

  it("a writer count row raises a rollup that listed fewer merges, and never lowers one", () => {
    const out = mergeShipped([rollup("hq-pro", 1, "HQ Pro"), rollup("hq-cli", 3, "CLI")], [
      writerShip("s1", "HQ Pro: 9 changes shipped", "HQ Pro", { why: "Keys stay inside their company." }),
      writerShip("s2", "CLI: 2 changes shipped", "CLI"),
    ]);
    expect(out.map((s) => s.id)).toEqual(["ship:hq-pro", "ship:hq-cli"]);
    expect(rowMerged(out[0]!)).toBe(9);
    expect(out[0]).toMatchObject({ status: "9 merged", why: "Keys stay inside their company." });
    expect(out[0]!.lines).toHaveLength(1);
    expect(rowMerged(out[1]!)).toBe(3);
    expect(shippedTiles(out).map((t) => [t.product, t.merged])).toEqual([
      ["HQ Pro", 9],
      ["CLI", 3],
    ]);
  });
});

describe("mergeTeam", () => {
  const dm = (id: string, name: string, dmCount: number): BriefTeammate => ({ id, name, doing: "Messaged you", tone: "ok", dmCount, isAgent: false });

  it("writer people win on status, tone and load; the DM count and unmatched senders stay", () => {
    const team = [dm("prs_ada", "Ada", 2), dm("prs_dee", "Dee", 1)];
    const people: BriefTeammate[] = [
      { id: "Ada", name: "Ada", doing: "Waiting on your check.", tone: "decision", isAgent: false, load: "heavy", owes: ["the launch email"] },
      { id: "agt_izzy", name: "Izzy", doing: "Watching the thread", tone: "neutral", isAgent: true },
    ];
    expect(mergeTeam(team, people)).toEqual([
      { id: "prs_ada", name: "Ada", doing: "Waiting on your check.", tone: "decision", dmCount: 2, isAgent: false, load: "heavy", owes: ["the launch email"] },
      { id: "agt_izzy", name: "Izzy", doing: "Watching the thread", tone: "neutral", isAgent: true },
      dm("prs_dee", "Dee", 1),
    ]);
    expect(team[0]!.doing).toBe("Messaged you");
  });
});

describe("mergeMeetings", () => {
  const meeting = (id: string, title: string, startTime: string, extra: Partial<BriefMeeting> = {}): BriefMeeting => ({
    id,
    title,
    startTime,
    companyUid: INDIGO,
    decisions: 0,
    actions: 0,
    risks: 0,
    questions: 0,
    ...extra,
  });

  it("matches by title or start, takes the writer's lines and attendance, adds unknown meetings with a start, drops startless ones", () => {
    const existing = [meeting("sw-0", "Launch sync", "2026-10-10T15:00:00Z", { decisions: 1 }), meeting("sw-1", "Board prep", "2026-10-10T17:00:00Z")];
    const writer = [
      meeting("m1", "launch sync", "", { decided: ["Ship Friday"], attended: true, durationMin: 30, with: "the launch team" }),
      meeting("m2", "Prep for the board", "2026-10-10T17:00:00Z", { attended: false }),
      meeting("m3", "Investor call", "2026-10-10T18:00:00Z", { decisions: 2, attended: true }),
      meeting("m4", "No start", "", { attended: true }),
    ];
    const out = mergeMeetings(existing, writer);
    expect(out.map((m) => [m.id, m.attended ?? null, m.decisions])).toEqual([
      ["sw-0", true, 1],
      ["sw-1", false, 0],
      ["m3", true, 2],
    ]);
    expect(out[0]).toMatchObject({ decided: ["Ship Friday"], durationMin: 30, with: "the launch team" });
    expect(existing[0]!.attended).toBeUndefined();
  });
});

describe("mergeReleases", () => {
  const release = (product: string, extra: Partial<BriefRelease> = {}): BriefRelease => ({
    product,
    version: null,
    origin: { companyUid: INDIGO, repo: null, product },
    releasedAt: null,
    pending: [],
    pendingCount: 0,
    held: [],
    light: "ok",
    ...extra,
  });

  it("the writer's held items, light and prompt win; the sweep's counts stay when the writer has none; new products are added", () => {
    const sweep = [release("Desktop app", { version: "0.11.3", releasedAt: "2026-10-10T21:00:00Z", pending: [{ day: "2026-10-11", count: 3, theme: "onboarding" }], pendingCount: 3, origin: { companyUid: INDIGO, repo: "indigoai-us/hq-desktop-app", product: "Desktop app" } })];
    const writer = [release("Desktop app", { held: [{ title: "Pricing page", why: "waits on the answer" }], light: "warn", prompt: "Cut it." }), release("HQ Pro", { pendingCount: 5, light: "red" })];
    const out = mergeReleases(sweep, writer);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      product: "Desktop app",
      version: "0.11.3",
      pending: [{ day: "2026-10-11", count: 3, theme: "onboarding" }],
      pendingCount: 3,
      held: [{ title: "Pricing page", why: "waits on the answer" }],
      light: "warn",
      prompt: "Cut it.",
      origin: { repo: "indigoai-us/hq-desktop-app" },
    });
    expect(out[1]).toMatchObject({ product: "HQ Pro", pendingCount: 5, light: "red" });
    expect(sweep[0]!.held).toEqual([]);
  });
});

describe("applyRunItems with an empty brief.json", () => {
  it("leaves every new list absent and only sets default prefs", () => {
    const input = baseInput(new Date(2026, 9, 11, 9, 0), "Corey", [{ uid: INDIGO, slug: "indigo", label: "Indigo" }], null);
    const before = JSON.stringify(input);
    applyRunItems(input, parseBriefItems("{}", INDIGO)!);
    expect(input.prefs).toEqual({ density: "auto", pinned: [], hidden: [], weights: {} });
    for (const key of ["carry", "handoffs", "recovered", "releases", "reminders", "days", "landedDays", "timeToClearMin", "leadHint", "fleetIncident", "mainHealth", "catchUp"] as const) {
      expect(input[key]).toBeUndefined();
    }
    expect(JSON.stringify({ ...input, prefs: undefined })).toBe(before);
  });
});
