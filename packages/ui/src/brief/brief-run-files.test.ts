import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, parseBriefItems, parseHousekeeping, parsePrefs } from "./brief-run-files.js";
import { gatherBriefInput, readRunHousekeeping, type BriefSweepSource } from "./brief-data.js";
import { briefPrompts } from "./brief-prompts.js";
import sweepJson from "./fixtures/sweep-2026-10-08.json";

const RUN = "brief-20261008-090000";

const briefJson = {
  run_id: RUN,
  generated_at: "2026-10-08T16:00:00Z",
  catch_up: false,
  items: {
    decisions: [
      {
        id: "pr-412",
        title: "Merge the sync fix",
        why: "It unblocks the beta",
        unlocks: ["beta.4", { label: "QA pass" }],
        risk: "Touches the runner",
        repo: "indigoai-us/hq-desktop-app",
        action: "go",
        prompt: "Open PR 412 in indigoai-us/hq-desktop-app and check CI first.",
      },
      { title: "" },
    ],
    waiting: [{ who: "Stefan", what: "to review PR 410", prompt: "Nudge Stefan about PR 410." }, { who: "", what: "x" }],
    incidents: [{ title: "Main is red on hq-pro", summary: "Two failing jobs", prompt: "Look at hq-pro main CI." }],
  },
  learned_notes: ["Fleet moved down"],
};

describe("parseBriefItems", () => {
  it("maps decisions, waits and incidents with their run prompts, dropping bad items", () => {
    const items = parseBriefItems(JSON.stringify(briefJson), "cmp_indigo")!;
    expect(items.decisions).toHaveLength(1);
    expect(items.decisions[0]).toMatchObject({
      id: "pr-412",
      action: "go",
      prompt: "Open PR 412 in indigoai-us/hq-desktop-app and check CI first.",
      origin: { companyUid: "cmp_indigo", repo: "indigoai-us/hq-desktop-app" },
      detail: { why: "It unblocks the beta", risk: "Touches the runner", unlocks: [{ label: "beta.4" }, { label: "QA pass" }] },
    });
    expect(items.waiting.map((w) => w.who)).toEqual(["Stefan"]);
    expect(items.incidents[0]).toMatchObject({ severity: "incident", title: "Main is red on hq-pro" });
    expect(items.learnedNotes).toEqual(["Fleet moved down"]);
  });

  it("accepts a flat item list tagged with kind", () => {
    const items = parseBriefItems(JSON.stringify({ items: [{ kind: "decision", title: "Pick a name" }, { kind: "incident", title: "Down" }] }), null)!;
    expect(items.decisions.map((d) => d.title)).toEqual(["Pick a name"]);
    expect(items.incidents.map((d) => d.title)).toEqual(["Down"]);
  });

  it("returns null for non-object JSON", () => {
    expect(parseBriefItems("[]", null)).toBeNull();
    expect(parseBriefItems("{oops", null)).toBeNull();
  });
});

describe("parseHousekeeping", () => {
  it("reads tasks as a map or a list, and keeps only proposals with a prompt", () => {
    const hk = parseHousekeeping(
      JSON.stringify({
        tasks: { "hq doctor": { ok: true, summary: "All good" }, "/hq-sync": { ok: false, error: "offline" } },
        proposals: [
          { id: "wt", title: "Remove 3 merged worktrees", frees: "2.1 GB", risk: "low", prompt: "Check each worktree has no unpushed commits, then remove it." },
          { title: "No prompt here" },
        ],
      }),
    )!;
    expect(hk.tasks).toEqual([
      { name: "hq doctor", ok: true, summary: "All good", error: null },
      { name: "/hq-sync", ok: false, summary: "", error: "offline" },
    ]);
    expect(hk.proposals).toEqual([
      { id: "wt", title: "Remove 3 merged worktrees", frees: "2.1 GB", risk: "low", prompt: "Check each worktree has no unpushed commits, then remove it." },
    ]);
    expect(parseHousekeeping(JSON.stringify({ tasks: [{ name: "qmd", ok: true }] }))!.tasks[0]!.name).toBe("qmd");
  });
});

describe("gatherBriefInput with a run id", () => {
  const companies = [{ uid: "cmp_indigo", slug: "indigo", label: "Indigo" }];
  const NOW = new Date(2026, 9, 8, 9, 0);

  it("reads brief-data.json and brief.json from workspace/brief/<run_id>/ and prefers the run's prompts", async () => {
    const files: Record<string, string> = {
      [`workspace/brief/${RUN}/brief-data.json`]: JSON.stringify(sweepJson),
      [`workspace/brief/${RUN}/brief.json`]: JSON.stringify(briefJson),
    };
    const reads: string[] = [];
    const source: BriefSweepSource = {
      readHqFile: async (p) => {
        reads.push(p);
        return files[p] ?? null;
      },
    };
    // The fixture sweep is for Oct 8, read as "yesterday" from a brief made on Oct 9.
    const { input, failures } = await gatherBriefInput(
      {},
      { now: new Date(2026, 9, 9, 7, 40), companies, sweep: source, runId: RUN, log: () => {} },
    );
    // The run's two files, then index.jsonl for the previous run (absent here: no rotation, no failure).
    expect(reads).toEqual([`workspace/brief/${RUN}/brief-data.json`, `workspace/brief/${RUN}/brief.json`, "workspace/brief/index.jsonl"]);
    expect(failures).not.toContain("brief.json");
    expect(input.previous).toBeNull();
    expect([input.runId, input.previousRunId]).toEqual([RUN, null]);
    expect(input.merged).toBe(87);
    expect(input.decisions.map((d) => d.id)).toEqual(["pr-412"]);
    expect(input.risks[0]!.title).toBe("Main is red on hq-pro");
    const prompts = briefPrompts(input);
    expect(prompts["pr-412"]).toBe("Open PR 412 in indigoai-us/hq-desktop-app and check CI first.");
    expect(prompts[input.waitingOn[0]!.id]).toBe("Nudge Stefan about PR 410.");
  });

  it("names the files a partial run is missing", async () => {
    const source: BriefSweepSource = { readHqFile: async () => null };
    const { failures } = await gatherBriefInput({}, { now: NOW, companies, sweep: source, runId: RUN, log: () => {} });
    expect(failures).toEqual(expect.arrayContaining(["brief-data.json", "brief.json"]));
  });

  it("without a run id reads only the per-day sweep, as before", async () => {
    const reads: string[] = [];
    const source: BriefSweepSource = { readHqFile: async (p) => (reads.push(p), null) };
    const { failures } = await gatherBriefInput({}, { now: NOW, companies, sweep: source, log: () => {} });
    expect(reads).toEqual(["workspace/brief/2026-10-08/brief-data.json"]);
    expect(failures).not.toContain("brief-data.json");
  });

  it("readRunHousekeeping reads the run's housekeeping.json and logs bad JSON", async () => {
    const log: string[] = [];
    const ok = await readRunHousekeeping(
      { readHqFile: async (p) => (p === `workspace/brief/${RUN}/housekeeping.json` ? JSON.stringify({ tasks: {}, proposals: [] }) : null) },
      RUN,
    );
    expect(ok).toEqual({ tasks: [], proposals: [] });
    expect(await readRunHousekeeping({ readHqFile: async () => "{oops" }, RUN, (m) => log.push(m))).toBeNull();
    expect(log).toEqual(["housekeeping.json is not valid JSON"]);
  });
});

// ---------------------------------------------------------------------------
// Writer additions: every new brief.json field, with made-up content.
// ---------------------------------------------------------------------------

const fullBrief = {
  run_id: RUN,
  generated_at: "2026-10-08T16:00:00Z",
  today: "2026-10-08",
  lead_hint: "Pick the launch date first; the launch team waits on it.",
  catch_up: false,
  prefs_applied: {
    density: "calm",
    widgets: { pinned: ["runway", "bogus"], muted: ["focus", "needs", "sunrise"], weights: { team: -1, shipped: 7, nope: 2 }, density: "calm" },
  },
  priorities: [
    { rank: 2, text: "Answer the pricing question", because: "two people asked", item_id: "d2", score: 4 },
    { rank: 1, text: "Pick the launch date", because: "the launch team waits on it", item_id: "d1", score: 9.5 },
  ],
  week: [
    { date: "2026-10-07", sessions: 4, meetings: 1, merged: 3, opened: 2, beat: { kind: "crisis", label: "Checks went red", evidence: "two workflows" } },
    { date: "2026-10-06", sessions: 2, meetings: 0, merged: 1, opened: 1, beat: { kind: "wobble", label: "ignored" } },
    { date: "bad-date", sessions: 1 },
  ],
  landed_days: ["2026-10-07", "2026-10-06", "2026-10-07", "nope"],
  time_to_clear_min: 23.4,
  items: {
    decisions: [
      {
        id: "d1",
        title: "Pick the launch date",
        why: "The launch team waits on it",
        product: "Widget app",
        source: "meeting_signals",
        action: "decide",
        choices: ["This week", "Next week"],
        age_hours: 30,
        effort: "medium",
        people_waiting: 2,
        revenue: true,
        blocks: [
          { who: "Ada", what: "the launch email", kind: "person" },
          { who: "release 1.2", what: "waits on the date", kind: "work", repo: "widget-app" },
          { what: "nameless" },
        ],
        origin: { repo: "widget-app", number: 12, url: "https://example.test/pr/12" },
      },
      { id: "d2", title: "Answer the pricing question", why: "Two people asked", source: "dms", effort: "quick", age_hours: 5, people_waiting: 1, revenue: false },
    ],
    waiting: [
      { id: "w1", who: "Bo", what: "to review the pricing page", age_hours: 26, kind: "review", origin: { repo: "widget-site" } },
      { id: "w2", who: "Cy", what: "to reply", kind: "carrier-pigeon" },
    ],
    incidents: [
      { id: "p1", title: "Fix the failing nightly check", why: "It has failed for two days", product: "Widget cloud", source: "main_health", age_hours: 48 },
      { id: "p2", title: "Unstick two agents in setup", source: "fleet", product: "Fleet" },
    ],
    watch: [
      { id: "x1", title: "Review two open changes of yours", why: "They have sat a day", product: "Widget app", source: "prs", kind: "pr", prompt: "Open them." },
      { id: "x2", title: "Nightly check still red", kind: "ci", repo: "widget-cloud", workflow: "Nightly" },
    ],
    shipped: [
      {
        id: "s1",
        title: "Widget app 1.2 is out",
        why: "The release finished yesterday.",
        product: "Widget app",
        first: true,
        highlights: ["Faster first run", "#44 feat(x): new tour"],
        merge_hours_median: 3.5,
        origin: { repo: "widget-app" },
      },
      { title: "" },
    ],
    carry: [
      {
        id: "c1",
        title: "Fix the red checks",
        why: "Still red since the last brief",
        product: "Widget cloud",
        source: "main_health",
        carried_from: "brief-20261007-090000",
        carried_since: "2026-10-07T15:00:00Z",
        briefs: 2,
        item_id: "d1",
        prompt: "Look again.",
      },
      { id: "c2", title: "Call the printer", carried_from: "brief-20261007-090000" },
    ],
    handoffs: [
      {
        id: "h1",
        object: "The dashboard rollout",
        from: "Ada",
        to: "Bo",
        me: false,
        production: true,
        since: "2026-10-08T09:00:00Z",
        receipts: { access: true, ack: false },
        note: "Second half still open",
        product: "Widget app",
        prompt: "Nudge Bo.",
      },
      { id: "h2" },
    ],
    recovered: [
      {
        id: "f1",
        title: "Nightly check is green again",
        what: "The fixture upload was fixed",
        at: "2026-10-08T11:00:00Z",
        source: "main_health",
        product: "Widget cloud",
        timeline: [{ at: "2026-10-07T10:00:00Z", text: "Went red" }, { at: "2026-10-08T11:00:00Z", text: "Fixed" }, { text: "" }],
        post_incident: { broke: "An upload step", did: "Pinned the version", changes: "One line" },
      },
      { id: "f2", title: "Agents came back", source: "moon" },
    ],
    releases: [
      {
        product: "Widget app",
        version: "1.2.0",
        released_at: "2026-10-07T21:00:00Z",
        pending: [{ day: "2026-10-08", count: 3, theme: "onboarding" }, { day: "", count: 1 }],
        held: [{ title: "Pricing page", why: "waits on the answer" }],
        light: "warn",
        prompt: "Cut it.",
        origin: { repo: "widget-app" },
      },
      { version: "9" },
    ],
    reminders: [
      { id: "r1", text: "remind me to call the printer friday", said_at: "2026-10-07T18:00:00Z", where: "dm to self", due_at: "2026-10-09T15:00:00Z", prompt: "Call the printer." },
      { id: "r2" },
    ],
    meetings: [
      {
        id: "m1",
        title: "Launch sync",
        start: "2026-10-07T15:00:00-04:00",
        signals: { decision: 2, action_item: 1, risk: 1 },
        decided: ["Ship on Friday"],
        todo: [{ text: "Write the launch note", owner: "Owner", mine: true }],
        attended: true,
        duration_min: 25,
        with: "the launch team",
      },
      { title: "Skipped call", start: "2026-10-07T17:00:00-04:00", attended: false },
    ],
    people: [
      { name: "Ada Lovelace", uid: "prs_ada", agent: false, status: "Dashboard live; waiting on your signed-in check.", load: "heavy", owes: ["the launch email"], thanks: "Shipped the dashboard" },
      { name: "Izzy", uid: "agt_izzy", agent: true, status: "Watching the thread", load: "steady" },
      { name: "Bo", status: "Sent the ranked fixes", load: "storm" },
      { name: "" },
    ],
  },
};

describe("parseBriefItems: writer additions", () => {
  const items = parseBriefItems(JSON.stringify(fullBrief), "cmp_indigo")!;

  it("reads the root: today, lead hint, prefs (unknown kinds dropped, never-hidden kept, weights clamped), week, landed days, time to clear", () => {
    expect(items.today).toBe("2026-10-08");
    expect(items.leadHint).toBe("Pick the launch date first; the launch team waits on it.");
    expect(items.prefs).toEqual({ density: "calm", pinned: ["runway"], hidden: ["focus"], weights: { team: -1, shipped: 2 } });
    expect(items.days).toEqual([
      { date: "2026-10-06", sessions: 2, meetings: 0, merged: 1, opened: 1 },
      { date: "2026-10-07", sessions: 4, meetings: 1, merged: 3, opened: 2, beat: { kind: "crisis", label: "Checks went red", evidence: "two workflows" } },
    ]);
    expect(items.landedDays).toEqual(["2026-10-06", "2026-10-07"]);
    expect(items.timeToClearMin).toBe(23);
  });

  it("ranks priorities by rank or n and keeps the score", () => {
    expect(items.priorities).toEqual([
      { n: 1, text: "Pick the launch date", because: "the launch team waits on it", itemId: "d1", score: 9.5 },
      { n: 2, text: "Answer the pricing question", because: "two people asked", itemId: "d2", score: 4 },
    ]);
  });

  it("decisions carry blocks, age, effort, people waiting, revenue, source, choices, origin.repo and carriedBriefs from carry", () => {
    const [d1, d2] = items.decisions;
    expect(d1).toMatchObject({
      id: "d1",
      choices: ["This week", "Next week"],
      ageHours: 30,
      effort: "medium",
      peopleWaiting: 2,
      revenue: true,
      source: "meeting_signals",
      carriedBriefs: 2,
      origin: { companyUid: "cmp_indigo", repo: "widget-app", product: "Widget app" },
    });
    expect(d1!.blocks).toEqual([
      { who: "Ada", what: "the launch email", kind: "person" },
      { who: "release 1.2", what: "waits on the date", kind: "work", origin: { companyUid: "cmp_indigo", repo: "widget-app" } },
    ]);
    expect(d2).toMatchObject({ id: "d2", effort: "quick", revenue: false, source: "dms" });
    expect(d2!.carriedBriefs).toBeUndefined();
    expect(d2!.blocks).toBeUndefined();
  });

  it("waits carry age, a known kind and an origin; an unknown kind is left out", () => {
    expect(items.waiting[0]).toEqual({ id: "w1", who: "Bo", what: "to review the pricing page", ageHours: 26, kind: "review", origin: { companyUid: "cmp_indigo", repo: "widget-site" } });
    expect(items.waiting[1]).toEqual({ id: "w2", who: "Cy", what: "to reply" });
  });

  it("a wait names who and what: older field names are read, and the historical {title, why} shape with nobody named is dropped", () => {
    const parsed = parseBriefItems(
      JSON.stringify({
        items: {
          waiting: [
            // What every historical run wrote: no `who`, so the card has nobody to show.
            { id: "w0", company: "indigo", source: "prs", title: "Review of the pricing page", why: "It has sat a day", age_hours: 26, kind: "review" },
            { id: "w1", from: "Geoff Hale", title: "widget-site #410: fix(pricing): the pricing page review", age_hours: 20, kind: "review" },
            { id: "w2", name: "Izzy", what: "to finish the memo folder", kind: "handoff" },
            { id: "w3", person: "Jacob", title: "to send the deck", kind: "dm" },
          ],
        },
      }),
      "cmp_indigo",
    )!;
    expect(parsed.waiting.map((w) => [w.id, w.who, w.what])).toEqual([
      ["w1", "Geoff Hale", "The pricing page review"],
      ["w2", "Izzy", "to finish the memo folder"],
      ["w3", "Jacob", "to send the deck"],
    ]);
  });

  it("incidents name the product when no repo is known, and the fleet-sourced one is remembered", () => {
    expect(items.incidents[0]!.ci).toMatchObject({ repo: "Widget cloud", ageHours: 48, note: "It has failed for two days" });
    expect(items.fleetIncidentId).toBe("p2");
  });

  it("watch rows are standing risks; a ci one carries its detail", () => {
    expect(items.watch.map((w) => [w.id, w.severity, !!w.ci])).toEqual([
      ["x1", "watch", false],
      ["x2", "watch", true],
    ]);
    expect(items.watch[0]).toMatchObject({ summary: "They have sat a day", prompt: "Open them.", origin: { product: "Widget app" } });
    expect(items.watch[1]!.ci).toMatchObject({ repo: "widget-cloud", workflow: "Nightly" });
  });

  it("shipped rows keep id, first, why, plain highlights and the median; an empty row is dropped", () => {
    expect(items.shipped).toEqual([
      {
        id: "s1",
        title: "Widget app 1.2 is out",
        status: "",
        note: "",
        origin: { companyUid: "cmp_indigo", repo: "widget-app", product: "Widget app" },
        lines: [],
        first: true,
        why: "The release finished yesterday.",
        highlights: ["Faster first run", "New tour"],
        mergeHoursMedian: 3.5,
      },
    ]);
  });

  it("carry rows default to one brief and no linked item", () => {
    expect(items.carry).toEqual([
      {
        id: "c1",
        title: "Fix the red checks",
        why: "Still red since the last brief",
        origin: { companyUid: "cmp_indigo", repo: null, product: "Widget cloud" },
        carriedFrom: "brief-20261007-090000",
        carriedSince: "2026-10-07T15:00:00Z",
        briefs: 2,
        itemId: "d1",
        prompt: "Look again.",
      },
      { id: "c2", title: "Call the printer", why: "Call the printer", origin: { companyUid: "cmp_indigo", repo: null }, carriedFrom: "brief-20261007-090000", carriedSince: null, briefs: 1, itemId: null },
    ]);
  });

  it("handoffs need an object; unknown receipts stay null, never done", () => {
    expect(items.handoffs).toEqual([
      {
        id: "h1",
        object: "The dashboard rollout",
        from: "Ada",
        to: "Bo",
        me: false,
        production: true,
        since: "2026-10-08T09:00:00Z",
        receipts: { access: true, ack: false, active: null },
        note: "Second half still open",
        origin: { companyUid: "cmp_indigo", repo: null, product: "Widget app" },
        prompt: "Nudge Bo.",
      },
    ]);
  });

  it("recovered rows keep a timeline and post-incident lines; an unknown source reads as session", () => {
    expect(items.recovered[0]).toMatchObject({
      id: "f1",
      source: "main_health",
      at: "2026-10-08T11:00:00Z",
      timeline: [{ at: "2026-10-07T10:00:00Z", text: "Went red" }, { at: "2026-10-08T11:00:00Z", text: "Fixed" }],
      postIncident: { broke: "An upload step", did: "Pinned the version", changes: "One line" },
    });
    expect(items.recovered[1]).toMatchObject({ id: "f2", what: "Agents came back", source: "session" });
    expect(items.recovered[1]!.timeline).toBeUndefined();
  });

  it("releases need a product; pending days without a date are dropped and the count is summed when missing", () => {
    expect(items.releases).toEqual([
      {
        product: "Widget app",
        version: "1.2.0",
        origin: { companyUid: "cmp_indigo", repo: "widget-app", product: "Widget app" },
        releasedAt: "2026-10-07T21:00:00Z",
        pending: [{ day: "2026-10-08", count: 3, theme: "onboarding" }],
        pendingCount: 3,
        held: [{ title: "Pricing page", why: "waits on the answer" }],
        light: "warn",
        prompt: "Cut it.",
      },
    ]);
  });

  it("reminders keep the owner's words; a textless one is dropped", () => {
    expect(items.reminders).toEqual([
      { id: "r1", text: "remind me to call the printer friday", saidAt: "2026-10-07T18:00:00Z", where: "dm to self", dueAt: "2026-10-09T15:00:00Z", prompt: "Call the printer." },
    ]);
  });

  it("meetings carry start, signal counts, attendance, length and who they were with", () => {
    expect(items.meetings[0]).toEqual({
      id: "m1",
      title: "Launch sync",
      startTime: "2026-10-07T15:00:00-04:00",
      companyUid: "cmp_indigo",
      decisions: 2,
      actions: 1,
      risks: 1,
      questions: 0,
      decided: ["Ship on Friday"],
      todo: [{ text: "Write the launch note", owner: "Owner", mine: true }],
      attended: true,
      durationMin: 25,
      with: "the launch team",
    });
    expect(items.meetings[1]).toMatchObject({ id: "brief-meeting-1", title: "Skipped call", attended: false, decisions: 0 });
  });

  it("people become teammates with load, owes and thanks; the status says who waits on you", () => {
    expect(items.people).toEqual([
      { id: "prs_ada", name: "Ada", doing: "Dashboard live; waiting on your signed-in check.", tone: "decision", isAgent: false, load: "heavy", owes: ["the launch email"], thanks: "Shipped the dashboard" },
      { id: "agt_izzy", name: "Izzy", doing: "Watching the thread", tone: "neutral", isAgent: true, load: "steady" },
      { id: "Bo", name: "Bo", doing: "Sent the ranked fixes", tone: "red", isAgent: false, load: "storm" },
    ]);
  });

  it("an empty brief yields empty lists and default prefs, never an error", () => {
    const empty = parseBriefItems("{}", null)!;
    expect(empty.prefs).toEqual(DEFAULT_PREFS);
    expect([empty.today, empty.leadHint, empty.timeToClearMin, empty.fleetIncidentId]).toEqual([null, null, null, null]);
    for (const key of ["decisions", "waiting", "incidents", "watch", "priorities", "meetings", "people", "shipped", "carry", "handoffs", "recovered", "releases", "reminders", "days", "landedDays"] as const) {
      expect(empty[key]).toEqual([]);
    }
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs({ muted: ["needs", "catchup", "sunrise", "team"], density: "loud" })).toEqual({ density: "auto", pinned: [], hidden: ["team"], weights: {} });
  });
});

// ---------------------------------------------------------------------------
// Folds across brief-data.json and brief.json, and the previous run's digest.
// ---------------------------------------------------------------------------

const RUN2 = "brief-20261011-090000";
const PREV = "brief-20261010-090000";
/** The brief is made the morning of Oct 11; "yesterday" for the sweep is Oct 10. */
const NOW2 = new Date(2026, 9, 11, 9, 0);

const sweep2 = {
  generated_at: "2026-10-11T14:00:00Z",
  company: "indigo",
  window: { from: "2026-10-10", to: "2026-10-11", today: "2026-10-11" },
  prs: [
    { repo: "hq-core-staging", product: "HQ core", number: 1, title: "fix(gate): retry", state: "merged", created: "2026-10-10T10:00:00Z", closed: "2026-10-10T12:00:00Z", merge_hours: 2 },
    { repo: "hq-cli", number: 2, title: "feat(cli): colors", state: "merged", created: "2026-10-10T10:00:00Z", closed: "2026-10-10T16:00:00Z", merge_hours: 6 },
    { repo: "hq-cli", number: 3, title: "fix(cli): typo", state: "open", created: "2026-10-10T18:00:00Z", closed: null },
  ],
  main_health: {
    "hq-core-staging": { workflows: 6, red: [{ workflow: "Promote", since: "2026-10-09T14:00:00Z", merges_on_top: 4 }] },
    "hq-cloud": { workflows: 3, red: ["Sync nightly"] },
    "hq-pro": { workflows: 4, red: ["pr-checks"] },
  },
  fleet: {
    total: 50,
    stuck: [{ name: "agent-a", status: "provisioning", phase: "waiting", since: "2026-10-09T12:00:00Z" }],
    delta: { newly_stuck: [], still_stuck: ["agent-a"], recovered: [] },
    series: [{ generated_at: "2026-10-10T14:00:00Z", stuck: 3 }],
  },
  dms: [
    { from: "Ada Lovelace", from_uid: "prs_ada", at: "2026-10-10T15:00:00Z" },
    { from: "Dee", from_uid: "prs_dee", at: "2026-10-10T16:00:00Z" },
  ],
  meeting_signals: [{ meeting: "Launch sync", start: "2026-10-10T15:00:00Z", counts: { decision: 1 } }],
  sessions: [],
};

const brief2 = {
  run_id: RUN2,
  today: "2026-10-11",
  items: {
    decisions: [{ id: "d3", title: "Fix the red release checks", source: "main_health", product: "HQ core", origin: { repo: "hq-core-staging" } }],
    incidents: [
      { id: "p1", title: "Fix the failing nightly sync check", source: "main_health", product: "HQ Cloud", age_hours: 48 },
      { id: "p2", title: "Unstick one agent in setup", source: "fleet", product: "Fleet" },
    ],
    shipped: [
      { id: "s1", title: "Core 2.0 is out", product: "HQ core", first: true, why: "The release landed.", origin: { repo: "hq-core-staging" } },
      { id: "s2", title: "HQ command line", product: "HQ command line", why: "Colors landed.", highlights: ["Colors in the CLI"], origin: { repo: "hq-cli" } },
    ],
    people: [
      { name: "Ada Lovelace", uid: "prs_ada", status: "Waiting on your signed-in check.", load: "heavy" },
      { name: "Bo", status: "Sent the fixes" },
    ],
    meetings: [
      { id: "m1", title: "Launch sync", start: "2026-10-10T15:00:00Z", attended: true, duration_min: 30, decided: ["Ship Friday"] },
      { id: "m2", title: "Investor call", start: "2026-10-10T18:00:00Z", attended: true, signals: { decision: 1 } },
    ],
  },
};

const prevSweep = { generated_at: "2026-10-10T15:00:00Z", company: "indigo", window: { from: "2026-10-09", to: "2026-10-10", today: "2026-10-10" }, prs: [], main_health: {} };
const prevBrief = { run_id: PREV, today: "2026-10-10", items: { decisions: [{ id: "d9", title: "Pick a vendor" }, { id: "d8", title: "Approve the budget" }] } };
const index = [
  { run_id: PREV, created_at: "2026-10-10T15:05:00Z", state: "ready" },
  { run_id: "brief-20261010-120000", created_at: "2026-10-10T18:05:00Z", state: "failed" },
  { run_id: RUN2, created_at: "2026-10-11T15:05:00Z", state: "ready" },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

function runSource(files: Record<string, string>): BriefSweepSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readHqFile: async (p) => {
      reads.push(p);
      return files[p] ?? null;
    },
  };
}

const run2Files: Record<string, string> = {
  [`workspace/brief/${RUN2}/brief-data.json`]: JSON.stringify(sweep2),
  [`workspace/brief/${RUN2}/brief.json`]: JSON.stringify(brief2),
};
const prevFiles: Record<string, string> = {
  "workspace/brief/index.jsonl": index,
  [`workspace/brief/${PREV}/brief-data.json`]: JSON.stringify(prevSweep),
  [`workspace/brief/${PREV}/brief.json`]: JSON.stringify(prevBrief),
};
const companies2 = [{ uid: "cmp_indigo", slug: "indigo", label: "Indigo" }];
/** An empty adapter always fails these five live sources; the run files add nothing to them. */
const ADAPTER_FAILS = ["identity", "calendar", "meetings", "dm threads", "sessions"];
const runFailures = (failures: readonly string[]) => failures.filter((f) => !ADAPTER_FAILS.includes(f));

describe("gatherBriefInput: folds between the sweep and the writer", () => {
  it("folds a sweep red main into the writer's decision or incident on the same repo or product, keeping the rest", async () => {
    const { input } = await gatherBriefInput({}, { now: NOW2, companies: companies2, sweep: runSource(run2Files), runId: RUN2, log: () => {} });
    expect(input.risks.map((r) => r.id)).toEqual(["p1", "p2", "ci:hq-pro"]);
    // The writer's incident keeps its words and prompt slot; the sweep's facts fill what it left blank.
    expect(input.risks[0]!.ci).toMatchObject({ repo: "hq-cloud", workflow: "Sync nightly", ageHours: 48, note: "1 of 3 workflows red on main." });
    expect(input.decisions.map((d) => d.id)).toEqual(["d3"]);
    expect(input.mainHealth!.map((m) => [m.repo, m.red.length])).toEqual([
      ["hq-core-staging", 1],
      ["hq-cloud", 1],
      ["hq-pro", 1],
    ]);
    expect(input.mainHealth![0]!.red[0]).toEqual({ workflow: "Promote", since: "2026-10-09T14:00:00Z", mergesOnTop: 4 });
    expect(input.today).toBe("2026-10-11");
  });

  it("gives the fleet incident the writer's id so a priority can point at it", async () => {
    const { input } = await gatherBriefInput({}, { now: NOW2, companies: companies2, sweep: runSource(run2Files), runId: RUN2, log: () => {} });
    expect(input.fleetIncident).toMatchObject({ id: "p2", verdict: "healing", incidentEnd: null, incidentStart: "2026-10-09T12:00:00.000Z" });
    expect(input.fleetIncident!.stillStuck).toEqual([{ name: "agent-a", reason: "waiting in setup", since: "2026-10-09T12:00:00Z" }]);
    expect(input.fleetIncident!.series.map((s) => s.stuck)).toEqual([3, 1]);
  });

  it("merges writer shipped rows onto the sweep rollups by product or repo; a named ship stays its own row", async () => {
    const { input } = await gatherBriefInput({}, { now: NOW2, companies: companies2, sweep: runSource(run2Files), runId: RUN2, log: () => {} });
    expect(input.shipped.map((s) => s.id)).toEqual(["ship:hq-cli", "ship:hq-core-staging", "s1"]);
    const [cli, core, named] = input.shipped;
    expect(cli).toMatchObject({ origin: { product: "HQ command line" }, why: "Colors landed.", highlights: ["Colors in the CLI"], mergeHoursMedian: 6 });
    expect(cli!.lines).toHaveLength(1);
    expect(core).toMatchObject({ origin: { product: "HQ core" }, why: "The release landed.", mergeHoursMedian: 2 });
    expect(core!.first).toBeUndefined();
    expect(named).toMatchObject({ id: "s1", first: true, title: "Core 2.0 is out" });
    expect(input.shipped.filter((s) => s.first)).toHaveLength(1);
  });

  it("lays the writer's people over the DM team and adds the writer's meetings to the sweep's", async () => {
    const { input } = await gatherBriefInput({}, { now: NOW2, companies: companies2, sweep: runSource(run2Files), runId: RUN2, log: () => {} });
    expect(input.team.map((t) => [t.name, t.tone, t.dmCount ?? null, t.load ?? null])).toEqual([
      ["Ada", "decision", 1, "heavy"],
      ["Bo", "ok", null, null],
      ["Dee", "ok", 1, null],
    ]);
    expect(input.team[0]).toMatchObject({ id: "prs_ada", doing: "Waiting on your signed-in check." });
    expect(input.meetingsYesterday.map((m) => [m.title, m.attended, m.durationMin ?? null, m.decisions])).toEqual([
      ["Launch sync", true, 30, 1],
      ["Investor call", true, null, 1],
    ]);
    expect(input.meetingsYesterday[0]!.decided).toEqual(["Ship Friday"]);
  });
});

describe("gatherBriefInput: the previous run's digest", () => {
  it("finds the previous ready run in index.jsonl, loads its two files through the same path, and digests it", async () => {
    const source = runSource({ ...run2Files, ...prevFiles });
    const { input, failures } = await gatherBriefInput({}, { now: NOW2, companies: companies2, sweep: source, runId: RUN2, log: () => {} });
    expect(source.reads).toEqual([
      `workspace/brief/${RUN2}/brief-data.json`,
      `workspace/brief/${RUN2}/brief.json`,
      "workspace/brief/index.jsonl",
      `workspace/brief/${PREV}/brief-data.json`,
      `workspace/brief/${PREV}/brief.json`,
    ]);
    expect(runFailures(failures)).toEqual([]);
    expect(input.previous).toEqual({ runId: PREV, hashes: expect.objectContaining({ sunrise: expect.any(String), needs: "d8|d9" }) });
    expect(input.previousRunId).toBe(PREV);
    expect(input.runId).toBe(RUN2);
    // The previous digest never leaks into the current brief's lists.
    expect(input.decisions.map((d) => d.id)).toEqual(["d3"]);
  });

  it("is null, logged once and never a failure when the previous run is unreadable", async () => {
    const log = vi.fn();
    const missingBrief = { ...run2Files, ...prevFiles };
    delete missingBrief[`workspace/brief/${PREV}/brief.json`];
    const a = await gatherBriefInput({}, { now: NOW2, companies: companies2, sweep: runSource(missingBrief), runId: RUN2, log });
    expect(a.input.previous).toBeNull();
    expect(runFailures(a.failures)).toEqual([]);
    expect(log.mock.calls.filter((c) => String(c[0]).includes("no rotation"))).toHaveLength(1);

    const badData = { ...run2Files, ...prevFiles, [`workspace/brief/${PREV}/brief-data.json`]: "{oops" };
    const b = await gatherBriefInput({}, { now: NOW2, companies: companies2, sweep: runSource(badData), runId: RUN2, log: () => {} });
    expect(b.input.previous).toBeNull();
    expect(runFailures(b.failures)).toEqual([]);

    const noIndex = runSource(run2Files);
    const c = await gatherBriefInput({}, { now: NOW2, companies: companies2, sweep: noIndex, runId: RUN2, log: () => {} });
    expect(c.input.previous).toBeNull();
    expect(runFailures(c.failures)).toEqual([]);

    const throwing: BriefSweepSource = {
      readHqFile: async (p) => {
        if (p === "workspace/brief/index.jsonl") throw new Error("denied");
        return run2Files[p] ?? null;
      },
    };
    const d = await gatherBriefInput({}, { now: NOW2, companies: companies2, sweep: throwing, runId: RUN2, log: () => {} });
    expect(d.input.previous).toBeNull();
    expect(runFailures(d.failures)).toEqual([]);
  });

  it("honours previousRunId: null skips the index, a run id is used as given", async () => {
    const skip = runSource({ ...run2Files, ...prevFiles });
    const a = await gatherBriefInput({}, { now: NOW2, companies: companies2, sweep: skip, runId: RUN2, previousRunId: null, log: () => {} });
    expect(a.input.previous).toBeNull();
    expect(skip.reads).not.toContain("workspace/brief/index.jsonl");

    const given = runSource({ ...run2Files, ...prevFiles });
    const b = await gatherBriefInput({}, { now: NOW2, companies: companies2, sweep: given, runId: RUN2, previousRunId: PREV, log: () => {} });
    expect(b.input.previous?.runId).toBe(PREV);
    expect(given.reads).not.toContain("workspace/brief/index.jsonl");
  });

  it("the no-run brief has no previous", async () => {
    const source = runSource(prevFiles);
    const { input } = await gatherBriefInput({}, { now: NOW2, companies: companies2, sweep: source, log: () => {} });
    expect(input.previous).toBeUndefined();
    expect(source.reads).toEqual(["workspace/brief/2026-10-11/brief-data.json"]);
  });
});
