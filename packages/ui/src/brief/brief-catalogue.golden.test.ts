/**
 * Goldens for the three worked days of the catalogue spec (section 13), run
 * from the synthetic JSON fixtures in ./fixtures (same shape and counts as the
 * real runs, invented names). Where the built picker differs from the prose in
 * section 13 the difference is written down next to the expectation:
 *
 * - Oct 11: the spec's page (template 6B) was worked with eleven kinds built.
 *   With the whole catalogue built, Firsts measures (3 firsts, value 2) and is
 *   not a weekend filler, so the day has seven strong cards and fills template
 *   7, not 6B. The spec's "once firsts and blockedByMe are built -> template 8"
 *   does not happen either: the real data carries `unlocks` but no named
 *   `blocks`, so What your calls unblock is value 1 (section 5: "unlocks only:
 *   1") and only tops up below MIN_DENSITY; at seven strong cards there is no
 *   room for it. The 6B page is kept as a golden by unbuilding those two kinds.
 * - Oct 11 dropped list: carry (every row linked), oneThing (5 calls) and
 *   meetings (two days old) measure null. Section 5 calls that "no data", and
 *   section 10 lists no-data entries in the review strip from `plan.scored`,
 *   not from `plan.dropped`, so they are absent from `dropped` here. The risk
 *   reason says "4 things are worth watching" without the "3 of them your own
 *   open changes" clause: the entry's fact only counts red mains.
 * - Oct 15: as in the spec, plus the oneThing card (two calls on a catch-up
 *   day) and What got settled (nine decided lines) on the dropped list.
 */

import { describe, expect, it } from "vitest";
import { CATALOGUE, CATCH_UP_DENSITY, buildContext, entryOf, lintReason, type Dropped } from "./brief-catalogue.js";
import { generateBrief, leadLabel, type BriefPlan } from "./brief-generate.js";
import type { BriefInput, BriefWidgetKind } from "./brief-types.js";
import oct11Json from "./fixtures/brief-2026-10-11.json";
import oct15Json from "./fixtures/brief-2026-10-15.json";
import oct17Json from "./fixtures/brief-2026-10-17.json";

/** A fresh copy per call so a test that mutates the day cannot leak into the next. */
const load = (json: unknown): BriefInput => JSON.parse(JSON.stringify(json)) as BriefInput;
const octoberEleven = () => load(oct11Json);
const quietSaturday = () => load(oct17Json);
const catchUpThursday = () => load(oct15Json);

const header = (plan: BriefPlan) => `Lead ${leadLabel(plan.lead)} · ${plan.density} widget${plan.density === 1 ? "" : "s"} · ${plan.reason}`;
const shape = (plan: BriefPlan) => plan.widgets.map((w) => [w.kind, w.size, w.tier] as const);
const reasons = (plan: BriefPlan) => Object.fromEntries(plan.widgets.map((w) => [w.kind, w.reason])) as Record<BriefWidgetKind, string>;
const noData = (input: BriefInput) => {
  const ctx = buildContext(input);
  return CATALOGUE.filter((e) => !e.measure(ctx)).map((e) => e.id);
};

/** Flip `ready` on some kinds for one call, as a day before their cards existed. */
function withUnbuilt<T>(kinds: BriefWidgetKind[], fn: () => T): T {
  const entries = kinds.map((k) => entryOf(k) as { ready: boolean });
  for (const e of entries) e.ready = false;
  try {
    return fn();
  } finally {
    for (const e of entries) e.ready = true;
  }
}

describe("the fixtures mirror the real runs' shape", () => {
  it("Oct 11: 5 decisions with priorities, 2 incidents, 4 watch, 23 merged across 7 products with 3 firsts, 3 old meetings, team of 3 with two needing you, no waits, 2 linked carry rows, 6 own sessions", () => {
    const day = octoberEleven();
    expect(day.today).toBe("2026-10-11");
    expect(day.decisions).toHaveLength(5);
    expect(day.decisions.every((d) => d.detail!.unlocks.length > 0 && d.ageHours != null && d.peopleWaiting != null)).toBe(true);
    expect(day.decisions.filter((d) => d.revenue).map((d) => d.id)).toEqual(["d1", "d4"]);
    expect(day.decisions.some((d) => d.blocks?.length)).toBe(false);
    expect(day.priorities!.map((p) => p.itemId)).toEqual(["d1", "d4", "d5", "d2", "p2"]);
    expect(day.risks.filter((r) => r.severity === "incident")).toHaveLength(2);
    expect(day.risks.filter((r) => r.severity === "watch")).toHaveLength(4);
    expect(day.shipped).toHaveLength(7);
    expect(day.shipped.reduce((n, s) => n + s.lines.length, 0)).toBe(23);
    expect(day.merged).toBe(23);
    expect(day.shipped.filter((s) => s.first)).toHaveLength(3);
    expect(day.meetingsYesterday).toHaveLength(3);
    for (const m of day.meetingsYesterday) expect(m.startTime.slice(0, 10)).toBe("2026-10-09");
    expect(day.team).toHaveLength(3);
    expect(day.team.filter((t) => t.tone === "decision")).toHaveLength(2);
    expect(day.waitingOn).toEqual([]);
    expect(day.carry!.map((c) => c.itemId)).toEqual(["d3", "p2"]);
    expect(buildContext(day).ownSessions).toHaveLength(6);
    expect(buildContext(day).dayType).toBe("weekend");
  });

  it("the fixtures carry no real names: no repo slugs on any face text, invented people and products only", () => {
    const text = JSON.stringify([oct11Json, oct15Json, oct17Json]);
    expect(text).not.toMatch(/indigo|liverecover|Corey|Geoff|Jonathan|Izzy|Jacob|Hassaan|SAFE|Ramen/i);
    expect(text).not.toMatch(/hq-[a-z]/);
  });
});

describe("golden: the real 2026-10-11 run, a Sunday, every kind built", () => {
  it("fills template 7: sunrise L, needs M, incident S, risk S, shipped W, team W, firsts W", () => {
    const plan = generateBrief(octoberEleven());
    expect(plan.dayType).toBe("weekend");
    expect(plan.lead).toBe("decisions");
    expect(header(plan)).toBe('Lead Decisions · 7 widgets · "Approve the vendor contract renewal" leads · 5 calls and a live incident');
    expect(plan.leadPriority).toMatchObject({ n: 1, text: "Approve the vendor contract renewal", because: "Finance and the renewal date wait on it", itemId: "d1" });
    expect(plan.template).toBe("7");
    expect(plan.density).toBe(7);
    expect(plan.areas).toEqual([
      "sunrise sunrise sunrise needs needs incident",
      "sunrise sunrise sunrise needs needs risk",
      "shipped shipped team team firsts firsts",
    ]);
    expect(shape(plan)).toEqual([
      ["sunrise", "L", 1],
      ["needs", "M", 2],
      ["incident", "S", 2],
      ["risk", "S", 3],
      ["shipped", "W", 3],
      ["team", "W", 3],
      ["firsts", "W", 3],
    ]);
    expect(plan.widgets.map((w) => [w.kind, w.score])).toEqual([
      ["sunrise", 30],
      ["needs", 30],
      ["incident", 30],
      ["risk", 30],
      ["shipped", 30],
      ["team", 26],
      ["firsts", 20],
    ]);
  });

  it("explains every card in one linted sentence, quoting the priority it serves", () => {
    const plan = generateBrief(octoberEleven());
    expect(reasons(plan)).toEqual({
      sunrise: "Always first: 5 calls before a clear day, and your 6 sessions since yesterday.",
      needs: 'Shown for priority 1, "Approve the vendor contract renewal": it and 4 more calls wait on you.',
      incident: 'Shown for priority 5, "Restart the four stalled worker agents": it is live, and Beacon\'s nightly sync has been red for 2 days.',
      risk: "Shown because 4 things are worth watching.",
      shipped: "Shown because you merged 23 changes across 7 products yesterday, 3 of them firsts.",
      team: 'Shown for priority 2, "Pick which onboarding fixes ship this week": Avery and Blake are waiting on you.',
      firsts: "Shown because 3 firsts shipped yesterday.",
    });
    for (const w of plan.widgets) expect(lintReason(w.reason), w.kind).toBeNull();
    expect(plan.explain[0]).toBe("Sunrise — Always first: 5 calls before a clear day, and your 6 sessions since yesterday.");
    expect(plan.explain).toHaveLength(plan.widgets.length + plan.dropped.length);
  });

  it("drops only What your calls unblock (value 1 with unlocks only, no room at 7); carry, oneThing and meetings have no data; every priority is hosted", () => {
    const day = octoberEleven();
    const plan = generateBrief(day);
    expect(plan.dropped).toEqual<Dropped[]>([{ kind: "blockedByMe", why: "no room at 7 widgets" }]);
    expect(plan.scored.find((s) => s.kind === "blockedByMe")).toMatchObject({ tier: 3, score: 20, parts: { value: 10, priority: 10 } });
    expect(noData(day)).toEqual(
      expect.arrayContaining(["catchup", "oneThing", "fleetRecovery", "resolved", "waiting", "carry", "handoffs", "releaseTrain", "meetings", "decided", "weekArc", "agenda", "runway", "focus", "reminders"]),
    );
    expect(noData(day)).not.toContain("needs");
    expect(plan.dropped.filter((d) => String(d.kind).startsWith("priority-"))).toEqual([]);
    const hosted = new Set(plan.widgets.flatMap((w) => plan.scored.find((s) => s.kind === w.kind)!.ev.items));
    for (const id of ["d1", "d2", "d3", "d4", "d5", "p2"]) expect(hosted.has(id), id).toBe(true);
  });

  it("is the spec's template 6B when Firsts and What your calls unblock are not built yet (eleven-kind catalogue)", () => {
    // Review mode still scores the unbuilt entries so the placeholders can say what they would have said.
    const { plan, unbuilt } = withUnbuilt(["firsts", "blockedByMe"], () => {
      const p = generateBrief(octoberEleven());
      return { plan: p, unbuilt: p.scored.filter((s) => !s.entry.ready).map((s) => s.kind) };
    });
    expect(unbuilt).toEqual(["blockedByMe", "firsts"]);
    expect(plan.template).toBe("6B");
    expect(header(plan)).toBe('Lead Decisions · 6 widgets · "Approve the vendor contract renewal" leads · 5 calls and a live incident');
    expect(plan.areas).toEqual([
      "sunrise sunrise sunrise needs needs incident",
      "sunrise sunrise sunrise needs needs risk",
      "shipped shipped shipped team team team",
    ]);
    expect(shape(plan)).toEqual([
      ["sunrise", "L", 1],
      ["needs", "M", 2],
      ["incident", "S", 2],
      ["risk", "S", 3],
      ["shipped", "W3", 3],
      ["team", "W3", 3],
    ]);
    expect(plan.dropped).toEqual<Dropped[]>([
      { kind: "blockedByMe", why: "no card yet; it would say: 5 calls of yours free 7 things" },
      { kind: "firsts", why: "no card yet; it would say: 3 firsts shipped yesterday" },
    ]);
  });

  it("with named blocks on two calls, What your calls unblock joins the page and Firsts is the one left without room (seven wide-capable cards, template 8 has three wide slots)", () => {
    const day = octoberEleven();
    day.decisions[0]!.blocks = [{ who: "Blake", what: "the renewal paperwork", kind: "person" }];
    day.decisions[3]!.blocks = [{ who: "Avery", what: "the onboarding plan", kind: "person" }];
    const plan = generateBrief(day);
    expect(plan.template).toBe("7");
    expect(shape(plan)).toEqual([
      ["sunrise", "L", 1],
      ["needs", "M", 2],
      ["incident", "S", 2],
      ["risk", "S", 3],
      ["shipped", "W", 3],
      ["blockedByMe", "W", 3],
      ["team", "W", 3],
    ]);
    expect(reasons(plan).blockedByMe).toBe('Shown for priority 1, "Approve the vendor contract renewal": it frees Blake.');
    expect(plan.dropped).toEqual<Dropped[]>([{ kind: "firsts", why: "no room at 7 widgets" }]);
    // The eight-card variant was tried first and could not seat every pick; the step down is by design.
    expect(plan.scored.filter((s) => s.tier === 2 || (s.tier === 3 && s.ev.value >= 2))).toHaveLength(7);
  });
});

describe("golden: a quiet Saturday, 2026-10-17", () => {
  it("is the hero alone on template 1, no holes, both fillers named in the dropped list", () => {
    const plan = generateBrief(quietSaturday());
    expect(plan.dayType).toBe("weekend");
    expect(header(plan)).toBe("Lead Your day · 1 widget · a quiet day");
    expect(plan.leadPriority).toBeNull();
    expect(plan.template).toBe("1");
    expect(plan.areas).toEqual(["sunrise sunrise sunrise sunrise sunrise sunrise", "sunrise sunrise sunrise sunrise sunrise sunrise"]);
    expect(shape(plan)).toEqual([["sunrise", "XL", 1]]);
    expect(plan.widgets[0]).toMatchObject({ slot: "a", cols: 6, rows: 2, reason: "Always first: a clear day, and your 2 sessions since yesterday." });
    expect(plan.dropped).toEqual<Dropped[]>([
      { kind: "risk", why: "a weekend filler; it comes back Monday" },
      { kind: "shipped", why: "a weekend filler; it comes back Monday" },
    ]);
  });

  it("the unchanged watch row lost five points to rotation before the weekend gate ran; on a Monday both fillers come back", () => {
    const day = quietSaturday();
    const monday = generateBrief({ ...day, today: "2026-10-19", now: "2026-10-19T14:00:00.000Z", lastBriefAt: "2026-10-18T14:00:00.000Z" });
    expect(monday.dayType).toBe("monday");
    expect(monday.widgets.map((w) => w.kind)).toEqual(["sunrise", "shipped", "risk"]);
    expect(monday.template).toBe("3");
    const risk = monday.scored.find((s) => s.kind === "risk")!;
    expect(risk.parts).toEqual({ value: 10, priority: 0, day: 0, pref: 0, rotation: 5 });
    expect(risk.score).toBe(5);
    expect(monday.scored.find((s) => s.kind === "shipped")!.score).toBe(10);
  });
});

describe("golden: catch-up Thursday 2026-10-15, four days away", () => {
  it("fills template 5: catchup XL, needs M, meetings S, carry S, weekArc W3", () => {
    const plan = generateBrief(catchUpThursday());
    expect(plan.dayType).toBe("catch-up");
    expect(plan.daysAway).toBe(4);
    expect(header(plan)).toBe('Lead Catch-up · 5 widgets · "Approve the fourth-quarter plan" leads · you were away 4 days');
    expect(plan.template).toBe("5");
    expect(plan.density).toBe(CATCH_UP_DENSITY);
    expect(plan.areas).toEqual([
      "catchup catchup catchup needs needs meetings",
      "catchup catchup catchup needs needs carry",
      "catchup catchup catchup weekArc weekArc weekArc",
    ]);
    expect(shape(plan)).toEqual([
      ["catchup", "XL", 1],
      ["needs", "M", 2],
      ["meetings", "S", 3],
      ["carry", "S", 3],
      ["weekArc", "W3", 3],
    ]);
    expect(plan.widgets.map((w) => [w.kind, w.score])).toEqual([
      ["catchup", 30],
      ["needs", 20],
      ["meetings", 35],
      ["carry", 30],
      ["weekArc", 45],
    ]);
  });

  it("day bonuses: weekArc 30 + 15, carry 20 + 10, meetings 30 + 5; the reasons say it is your first day back", () => {
    const plan = generateBrief(catchUpThursday());
    const parts = (k: BriefWidgetKind) => plan.scored.find((s) => s.kind === k)!.parts;
    expect(parts("weekArc")).toMatchObject({ value: 30, day: 15 });
    expect(parts("carry")).toMatchObject({ value: 20, day: 10 });
    expect(parts("meetings")).toMatchObject({ value: 30, day: 5 });
    expect(reasons(plan)).toEqual({
      catchup: 'Always first: you were away 4 days: what changed, in five tiles, starting with "Approve the fourth-quarter plan".',
      needs: 'Shown for priority 1, "Approve the fourth-quarter plan": it and 1 more call wait on you.',
      meetings: "Shown because it is your first day back: 9 meetings since yesterday, 9 decisions made, 2 to-dos yours.",
      carry: "Shown because it is your first day back: 1 thing carried from earlier briefs with no card today, one for 2 briefs running.",
      weekArc: "Shown because it is your first day back: 4 days of work, 2 turning points, 18 sessions.",
    });
    for (const w of plan.widgets) expect(lintReason(w.reason), w.kind).toBeNull();
  });

  it("incident, shipped, resolved and handoffs fold into the Welcome back tiles; oneThing yields to Needs you; What got settled finds no room", () => {
    const plan = generateBrief(catchUpThursday());
    const why = Object.fromEntries(plan.dropped.map((d) => [d.kind, d.why]));
    expect(why).toEqual({
      incident: "shown in the Welcome back tiles",
      shipped: "shown in the Welcome back tiles",
      resolved: "shown in the Welcome back tiles",
      handoffs: "shown in the Welcome back tiles",
      oneThing: "Needs you shows every call; the priorities list orders them",
      decided: "no room at 5 widgets",
    });
    // The hero's tiles are exactly the folded items: the incident, the two calls, what recovered, what was handed over.
    expect(plan.scored.find((s) => s.kind === "catchup")!.ev.items).toEqual(["p1", "d1", "d2", "r1", "h1"]);
    expect(plan.dropped.filter((d) => String(d.kind).startsWith("priority-"))).toEqual([]);
  });

  it("never exceeds five widgets on a catch-up day, whatever else the day carries", () => {
    const day = catchUpThursday();
    day.risks.push(
      { id: "w1", title: "Sync retries doubled overnight", summary: "", severity: "watch", links: [], origin: { companyUid: "cmp_northwind", repo: null, product: "Beacon" } },
      { id: "w2", title: "The docs build prints a warning on every run", summary: "", severity: "watch", links: [], origin: { companyUid: "cmp_northwind", repo: null, product: "Grove" } },
    );
    day.team = [
      { id: "prs_avery", name: "Avery", doing: "Needs your call", tone: "decision" },
      { id: "prs_blake", name: "Blake", doing: "Needs your call", tone: "decision" },
    ];
    day.reminders = [{ id: "rm1", text: "call the bank on Thursday", saidAt: "2026-10-13T10:00:00.000Z", where: "Finance check-in", dueAt: "2026-10-15T18:00:00.000Z" }];
    const plan = generateBrief(day);
    expect(plan.density).toBeLessThanOrEqual(CATCH_UP_DENSITY);
    expect(plan.widgets[0]).toMatchObject({ kind: "catchup", slot: "a", size: "XL" });
  });
});
