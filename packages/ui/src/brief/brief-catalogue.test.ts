import { describe, expect, it } from "vitest";
import {
  CATALOGUE,
  CATCH_UP_DENSITY,
  MAX_DENSITY,
  PAIRS,
  QUIET_TEMPLATES,
  SPAN,
  TEMPLATES,
  VARIANTS,
  WIDEN,
  buildContext,
  checkCatalogue,
  density,
  digest,
  eligible,
  entryOf,
  fitsSlot,
  leadReason,
  lexBetter,
  lintReason,
  pairRuleFor,
  pick,
  rankDecisions,
  reasonFor,
  weekdayOf,
  type Dropped,
} from "./brief-catalogue.js";
import { FITS, generateBrief, type BriefPlan } from "./brief-generate.js";
import { octoberEightBrief } from "./brief-fixture.js";
import { briefPriorities } from "./brief-peeks.js";
import { catchUpThursday, decision, empty, everything, hoursAgo, octoberEleven, origin, quietSaturday, watch } from "./brief-catalogue-fixtures.js";
import type { BriefInput, BriefWidgetKind } from "./brief-types.js";

const kinds = (plan: BriefPlan) => plan.widgets.map((w) => w.kind);

describe("weekdayOf", () => {
  it("is pure arithmetic: Oct 11 2026 is a Sunday, Oct 12 a Monday, Oct 17 a Saturday", () => {
    expect(weekdayOf("2026-10-11")).toBe(0);
    expect(weekdayOf("2026-10-12")).toBe(1);
    expect(weekdayOf("2026-10-17")).toBe(6);
    expect(weekdayOf("1970-01-01")).toBe(4);
  });

  it("buildContext reads today from the input and falls back to the date part of now", () => {
    expect(buildContext(octoberEleven()).dayType).toBe("weekend");
    expect(buildContext({ ...octoberEleven(), today: undefined }).today).toBe("2026-10-11");
    expect(buildContext({ ...octoberEleven(), today: "2026-10-12" }).dayType).toBe("monday");
    expect(buildContext({ ...octoberEleven(), today: "2026-10-16" }).dayType).toBe("friday");
    expect(buildContext(catchUpThursday()).dayType).toBe("catch-up");
    expect(buildContext({ ...octoberEleven(), today: "2026-10-14", risks: [], recovered: everything().recovered }).dayType).toBe("post-incident");
  });
});

describe("catalogue and templates", () => {
  it("has the 23 entries in registry order with no fleet or other-company card", () => {
    expect(CATALOGUE.map((e) => e.id)).toEqual([
      "sunrise", "catchup", "needs", "oneThing", "blockedByMe", "incident", "fleetRecovery", "resolved", "risk", "waiting", "carry", "handoffs",
      "shipped", "firsts", "releaseTrain", "meetings", "decided", "weekArc", "team", "agenda", "runway", "focus", "reminders",
    ]);
    expect(Object.keys(FITS)).not.toContain("fleet");
    expect(Object.keys(FITS)).not.toContain("otherWork");
    expect(CATALOGUE.filter((e) => e.ready).map((e) => e.id)).toEqual([
      "sunrise", "catchup", "needs", "oneThing", "incident", "risk", "waiting", "shipped", "meetings", "team", "agenda",
    ]);
  });

  it("every entry fits a template slot and every non-hero slot size has at least three fitters", () => {
    expect(checkCatalogue()).toEqual([]);
    const nonHero = new Set(Object.values(TEMPLATES).flatMap((t) => Object.keys(t.cls).slice(1).map((s) => t.cls[s]!)));
    for (const size of nonHero) expect(CATALOGUE.filter((e) => fitsSlot(e, size)).length).toBeGreaterThanOrEqual(3);
    for (const e of CATALOGUE) expect(e.fits.length).toBeGreaterThan(0);
    // The hero slot is XL in template 1 and only the two heroes fit it by design.
    expect(CATALOGUE.filter((e) => e.fits.includes("XL")).map((e) => e.id)).toEqual(["sunrise", "catchup"]);
  });

  it("templates: one variant list per density, no '.' cells, six columns, slot a first; WIDEN only widens", () => {
    for (let n = 1; n <= MAX_DENSITY; n += 1) {
      for (const name of VARIANTS[n]!) {
        const tpl = TEMPLATES[name]!;
        expect(Object.keys(tpl.cls)).toHaveLength(n);
        expect(Object.keys(tpl.cls)[0]).toBe("a");
        for (const row of tpl.areas) {
          expect(row.split(" ")).toHaveLength(6);
          expect(row).not.toContain(".");
        }
      }
    }
    expect(WIDEN).toEqual({ L: "M", W3: "W" });
    expect(fitsSlot(entryOf("team"), "L")).toBe(true);
    expect(fitsSlot(entryOf("incident"), "W3")).toBe(true);
    expect(fitsSlot(entryOf("oneThing"), "M")).toBe(false);
    expect(SPAN).toEqual({ XL: [3, 3], L: [3, 2], M: [2, 2], W: [2, 1], W3: [3, 1], S: [1, 1] });
    expect(QUIET_TEMPLATES).toBe(true);
  });

  it("lexBetter prefers the variant that places a better-ranked candidate", () => {
    expect(lexBetter([0, 2, 5], [0, 3, 4])).toBe(true);
    expect(lexBetter([0, 3, 4], [0, 2, 5])).toBe(false);
    expect(lexBetter([0, 2, 5], [0, 2, 5])).toBe(false);
  });
});

describe("the real Oct 11 run (a Sunday)", () => {
  it("picks template 6B: sunrise, needs, incident, risk, shipped, team", () => {
    const plan = generateBrief(octoberEleven());
    expect(plan.dayType).toBe("weekend");
    expect(plan.template).toBe("6B");
    expect(plan.density).toBe(6);
    expect(plan.areas).toEqual([
      "sunrise sunrise sunrise needs needs incident",
      "sunrise sunrise sunrise needs needs risk",
      "shipped shipped shipped team team team",
    ]);
    expect(plan.widgets.map((w) => [w.kind, w.size, w.tier])).toEqual([
      ["sunrise", "L", 1],
      ["needs", "M", 2],
      ["incident", "S", 2],
      ["risk", "S", 3],
      ["shipped", "W3", 3],
      ["team", "W3", 3],
    ]);
    expect(plan.widgets.find((w) => w.kind === "team")!.score).toBe(26);
    expect(plan.widgets.find((w) => w.kind === "risk")!.score).toBe(30);
    expect(plan.widgets.find((w) => w.kind === "shipped")!.score).toBe(30);
  });

  it("explains the header, the hero and every card in one sentence each", () => {
    const plan = generateBrief(octoberEleven());
    expect(plan.lead).toBe("decisions");
    expect(plan.reason).toBe('"Close out the $20-cap SAFE allotment" leads · 5 calls and a live incident');
    expect(plan.leadPriority).toMatchObject({ text: "Close out the $20-cap SAFE allotment", because: "Investors and the round close wait on it" });
    const reason = (k: BriefWidgetKind) => plan.widgets.find((w) => w.kind === k)!.reason;
    expect(reason("sunrise")).toBe("Always first: 5 calls before a clear day, and your 6 sessions since yesterday.");
    expect(reason("needs")).toBe('Shown for priority 1, "Close out the $20-cap SAFE allotment": it and 4 more calls wait on you.');
    expect(reason("incident")).toBe('Shown for priority 5, "Unstick five fleet agents in setup": it is live, and HQ Cloud\'s nightly sync has been red for 2 days.');
    expect(reason("risk")).toBe("Shown because 4 things are worth watching.");
    expect(reason("shipped")).toBe("Shown because you merged 23 changes across 7 products yesterday, one of them a first.");
    expect(reason("team")).toBe('Shown for priority 2, "Pick which signup fixes ship this week": Geoff and Jonathan are waiting on you.');
    expect(plan.explain[0]).toBe(`Sunrise — ${reason("sunrise")}`);
  });

  it("lists what is not shown, in each card's own words, and the not-built cards with what they would say", () => {
    const plan = generateBrief(octoberEleven());
    const why = Object.fromEntries(plan.dropped.map((d) => [d.kind, d.why]));
    expect(why.oneThing).toBeUndefined(); // 5 decisions: oneThing measures null, so it is "no data", not dropped
    expect(why.blockedByMe).toBeUndefined(); // no edges in this fixture
    expect(why.firsts).toMatch(/^no card yet; it would say: a first shipped yesterday$/);
    expect(plan.dropped.map((d) => d.kind)).not.toContain("meetings"); // two days old: measures null
    expect(plan.scored.map((s) => s.kind)).toContain("firsts");
    expect(plan.scored.find((s) => s.kind === "firsts")!.entry.ready).toBe(false);
    expect(plan.dropped.filter((d) => String(d.kind).startsWith("priority-"))).toEqual([]);
  });

  it("weekend gate keeps needs and anything that serves a priority, drops value-1 fillers", () => {
    const input = { ...octoberEleven(), risks: octoberEleven().risks.slice(0, 3) }; // one watch -> value 1
    const plan = generateBrief(input);
    expect(kinds(plan)).toContain("needs");
    expect(kinds(plan)).not.toContain("risk");
    expect(plan.dropped.find((d) => d.kind === "risk")?.why).toBe("a weekend filler; it comes back Monday");
    const monday = generateBrief({ ...input, today: "2026-10-12" });
    expect(kinds(monday)).toContain("risk");
  });

  it("Needs rows: referenced by a priority first (by rank), then weight, then age", () => {
    const ctx = buildContext(octoberEleven());
    expect(rankDecisions(ctx).map((d) => d.id)).toEqual(["d1", "d4", "d5", "d2", "d3"]);
  });

  it("once firsts and blockedByMe are built, a fit-beats-score case stays on the dropped list by design", () => {
    const input = { ...octoberEleven(), today: "2026-10-14" }; // a weekday, so value-1 cards are not gated
    input.decisions[0]!.blocks = [{ who: "Jonathan", what: "the round close", kind: "person" }];
    input.decisions[3]!.blocks = [{ who: "Geoff", what: "the pricing page", kind: "person" }];
    input.shipped[2]!.first = true; // two firsts -> firsts is strong and may share the grid with shipped
    const built = CATALOGUE.map((e) => e.ready);
    for (const e of CATALOGUE) if (e.id === "firsts" || e.id === "blockedByMe") (e as { ready: boolean }).ready = true;
    try {
      const plan = generateBrief(input);
      expect(["7", "8"]).toContain(plan.template);
      expect(kinds(plan)).toEqual(expect.arrayContaining(["sunrise", "needs", "incident", "blockedByMe", "risk", "shipped"]));
      // Eight strong cards compete for seven or eight slots: whatever did not fit says so, in the strip.
      const unplaced = plan.scored.filter((s) => s.entry.ready && !kinds(plan).includes(s.kind));
      expect(unplaced.length).toBeGreaterThan(0);
      for (const s of unplaced) expect(plan.dropped.find((d) => d.kind === s.kind)?.why).toMatch(/^(no slot fits it|no room) at [78] widgets$/);
      for (const w of plan.widgets) expect(fitsSlot(entryOf(w.kind), w.size)).toBe(true);
    } finally {
      CATALOGUE.forEach((e, i) => ((e as { ready: boolean }).ready = built[i]!));
    }
  });
});

describe("quiet Saturday and catch-up Thursday", () => {
  it("a quiet Saturday is the hero alone on template 1 with no holes", () => {
    const plan = generateBrief(quietSaturday());
    expect(plan.template).toBe("1");
    expect(plan.density).toBe(1);
    expect(kinds(plan)).toEqual(["sunrise"]);
    expect(plan.areas).toEqual(["sunrise sunrise sunrise sunrise sunrise sunrise", "sunrise sunrise sunrise sunrise sunrise sunrise"]);
    expect(plan.widgets[0]).toMatchObject({ cols: 6, rows: 2, size: "XL" });
    expect(plan.reason).toBe("a quiet day");
    expect(plan.dropped.map((d) => [d.kind, d.why])).toEqual([
      ["risk", "a weekend filler; it comes back Monday"],
      ["shipped", "a weekend filler; it comes back Monday"],
    ]);
    // Rotation: the unchanged watch row lost five points before the gate even ran.
    const ctx = buildContext(quietSaturday());
    const pool = eligible({ ...ctx, dayType: "midweek" }, []);
    expect(pool.find((s) => s.kind === "risk")!.parts.rotation).toBe(5);
    expect(pool.find((s) => s.kind === "risk")!.score).toBe(5);
  });

  it("a catch-up day leads with the Welcome back hero, caps at five, and folds incident/shipped into its tiles", () => {
    const plan = generateBrief(catchUpThursday());
    expect(plan.dayType).toBe("catch-up");
    expect(plan.lead).toBe("catch-up");
    expect(plan.density).toBeLessThanOrEqual(CATCH_UP_DENSITY);
    expect(plan.widgets[0]).toMatchObject({ kind: "catchup", size: "XL" });
    expect(kinds(plan)).not.toContain("sunrise");
    expect(kinds(plan)).toContain("needs");
    expect(kinds(plan)).toContain("meetings");
    expect(plan.dropped.find((d) => d.kind === "shipped")?.why).toBe("shown in the Welcome back tiles");
    expect(plan.widgets[0]!.reason).toBe('Always first: you were away 4 days: what changed, in five tiles, starting with "Approve the Q4 plan".');
    expect(plan.reason).toBe('"Approve the Q4 plan" leads · you were away 4 days');
    // Carry and weekArc carry their day bonus even though they are not built yet.
    const carry = plan.scored.find((s) => s.kind === "carry")!;
    expect(carry.parts.day).toBe(10);
    expect(plan.scored.find((s) => s.kind === "weekArc")!.parts.day).toBe(15);
    expect(plan.scored.find((s) => s.kind === "meetings")!.parts.day).toBe(5);
  });

  it("catch-up never exceeds five widgets, even with everything to show", () => {
    const plan = generateBrief({ ...everything(), lastBriefAt: hoursAgo("2026-10-14T13:00:00.000Z", 5 * 24) });
    expect(plan.density).toBeLessThanOrEqual(CATCH_UP_DENSITY);
    expect(plan.widgets[0]!.kind).toBe("catchup");
  });
});

describe("prefs", () => {
  const prefs = (p: Partial<BriefInput["prefs"]>) => ({ density: "auto" as const, pinned: [], hidden: [], weights: {}, ...p });

  it("hidden is never shown and is listed as dropped; sunrise, catchup and needs cannot be hidden", () => {
    const plan = generateBrief({ ...octoberEleven(), prefs: prefs({ hidden: ["team", "needs", "sunrise"] }) });
    expect(kinds(plan)).not.toContain("team");
    expect(kinds(plan)).toContain("needs");
    expect(kinds(plan)).toContain("sunrise");
    expect(plan.dropped.find((d) => d.kind === "team")?.why).toBe("hidden by you");
  });

  it("pinned sits in tier 2 below the cards that contain a priority", () => {
    const input = { ...octoberEleven(), prefs: prefs({ pinned: ["shipped"] }) };
    const ctx = buildContext(input);
    const pool = eligible(ctx, []);
    const order = pool.map((s) => s.kind);
    expect(order.slice(0, 4)).toEqual(["sunrise", "needs", "incident", "shipped"]);
    expect(pool[3]!.tier).toBe(2);
    expect(pool[3]!.why).toEqual({ kind: "pref" });
    const plan = generateBrief(input);
    expect(plan.widgets.find((w) => w.kind === "shipped")!.reason).toBe("Shown because you asked for it always; you merged 23 changes across 7 products yesterday, one of them a first.");
  });

  it("weights move a card five points per step, clamped to two steps; calm density caps at five", () => {
    const up = eligible(buildContext({ ...octoberEleven(), prefs: prefs({ weights: { team: 2 } }) }), []);
    expect(up.find((s) => s.kind === "team")!.score).toBe(36);
    const way = eligible(buildContext({ ...octoberEleven(), prefs: prefs({ weights: { team: 9 } }) }), []);
    expect(way.find((s) => s.kind === "team")!.score).toBe(36);
    const calm = generateBrief({ ...octoberEleven(), prefs: prefs({ density: "calm" }) });
    expect(calm.density).toBe(5);
    expect(calm.template).toBe("5");
  });
});

describe("pairs", () => {
  it("oneThing yields to Needs you unless Needs you sits in a one-row slot", () => {
    const now = "2026-10-14T13:00:00.000Z";
    const input: BriefInput = {
      ...empty(now, "2026-10-14"),
      decisions: [decision("d1", "Approve the plan", { detail: { why: "x", unlocks: [{ label: "A", state: "" }, { label: "B", state: "" }], source: "s" } })],
      priorities: [{ n: 1, text: "Approve the plan", because: "The team waits", itemId: "d1" }],
      shipped: [{ id: "ship:x", title: "x", status: "5 merged", note: "", origin: origin("indigoai-us/hq-pro", "HQ Pro"), lines: [] }],
      merged: 5,
      risks: [watch("w1", "A"), watch("w2", "B")],
      team: [
        { id: "prs_a", name: "Ann", doing: "x", tone: "ok" },
        { id: "prs_b", name: "Bob", doing: "y", tone: "ok" },
      ],
    };
    const plan = generateBrief(input);
    const both = kinds(plan).includes("needs") && kinds(plan).includes("oneThing");
    if (both) {
      expect(plan.widgets.find((w) => w.kind === "needs")!.rows).toBe(1);
    } else {
      expect(plan.dropped.find((d) => d.kind === "oneThing")?.why).toBe("Needs you shows every call; the priorities list orders them");
    }
    expect(pairRuleFor("needs", "oneThing")!.coexist(buildContext(input), [{ kind: "needs", rows: 2, size: "M" }])).toBe(false);
    expect(pairRuleFor("oneThing", "needs")!.coexist(buildContext(input), [{ kind: "needs", rows: 1, size: "W" }])).toBe(true);
  });

  it("the symmetric table has a skip sentence per rule and never pairs a kind with itself", () => {
    for (const r of PAIRS) {
      expect(r.pair[0]).not.toBe(r.pair[1]);
      expect(r.skip.length).toBeGreaterThan(10);
      expect(pairRuleFor(r.pair[1], r.pair[0])).toBe(r);
    }
    expect(pairRuleFor("agenda", "runway")!.coexist(buildContext(octoberEleven()), null)).toBe(false);
    expect(pairRuleFor("incident", "risk")).toBeNull();
  });

  it("agenda and runway never share the grid once runway is built", () => {
    const flip = (id: BriefWidgetKind, ready: boolean) => ((entryOf(id) as { ready: boolean }).ready = ready);
    flip("runway", true);
    try {
      const plan = generateBrief(everything());
      expect(kinds(plan).filter((k) => k === "agenda" || k === "runway").length).toBeLessThanOrEqual(1);
    } finally {
      flip("runway", false);
    }
  });
});

describe("determinism and lint", () => {
  // The Oct 8 preview day has no writer priorities; pin the derived ones so list shuffles do not change what leads.
  const octoberEight = (): BriefInput => {
    const x = { ...octoberEightBrief(new Date("2026-10-08T14:40:00.000Z")), today: "2026-10-08" };
    return { ...x, priorities: briefPriorities(x) };
  };
  const seeds = [octoberEleven, quietSaturday, catchUpThursday, everything, octoberEight];

  it("the same input gives the same plan across 50 runs and under list and key shuffles", () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const shuffle = <T>(xs: T[]): T[] => {
      const a = [...xs];
      for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rnd() * (i + 1));
        [a[i], a[j]] = [a[j]!, a[i]!];
      }
      return a;
    };
    for (const make of seeds) {
      const first = generateBrief(make());
      for (let i = 0; i < 50; i += 1) expect(generateBrief(make())).toEqual(first);
      for (let i = 0; i < 10; i += 1) {
        const x = make();
        const shuffled: BriefInput = {
          ...x,
          decisions: shuffle(x.decisions),
          risks: shuffle(x.risks),
          shipped: shuffle(x.shipped),
          team: shuffle(x.team),
          meetingsYesterday: shuffle(x.meetingsYesterday),
        };
        const reordered = Object.fromEntries(shuffle(Object.entries(shuffled))) as unknown as BriefInput;
        const plan = generateBrief(reordered);
        expect(plan.template).toBe(first.template);
        expect(plan.areas).toEqual(first.areas);
        expect(plan.widgets.map((w) => [w.kind, w.size, w.tier, w.score, w.reason])).toEqual(first.widgets.map((w) => [w.kind, w.size, w.tier, w.score, w.reason]));
        expect(plan.dropped).toEqual(first.dropped);
        expect(plan.scored.map((s) => [s.kind, s.score, s.ev])).toEqual(first.scored.map((s) => [s.kind, s.score, s.ev]));
      }
    }
  });

  it("every reason on every fixture day passes the lint, for shown cards, not-built cards and every pattern", () => {
    for (const make of seeds) {
      const input = make();
      const plan = generateBrief(input);
      const ctx = buildContext(input);
      for (const w of plan.widgets) expect(lintReason(w.reason), `${w.kind}: ${w.reason}`).toBeNull();
      for (const s of plan.scored) {
        for (const why of [{ kind: "value" as const }, { kind: "day" as const }, { kind: "pref" as const }, { kind: "pinned" as const }, s.why]) {
          const r = reasonFor(s.entry, s.ev, why, ctx);
          expect(lintReason(r), `${s.kind} (${why.kind}): ${r}`).toBeNull();
        }
        for (const serve of s.serves) {
          const r = reasonFor(s.entry, s.ev, { kind: "priority", serve }, ctx);
          expect(lintReason(r), `${s.kind} (priority): ${r}`).toBeNull();
        }
      }
      expect(plan.density).toBe(plan.widgets.length);
      expect(plan.density).toBeGreaterThanOrEqual(1);
      expect(plan.density).toBeLessThanOrEqual(MAX_DENSITY);
      expect(plan.widgets[0]!.slot).toBe("a");
      for (const row of plan.areas) expect(row).not.toContain(".");
      for (const w of plan.widgets) expect(fitsSlot(entryOf(w.kind), w.size)).toBe(true);
      expect(kinds(plan)).not.toContain("fleet");
      expect(kinds(plan)).not.toContain("otherWork");
    }
    // Every not-built entry has evidence on the "everything" day, so each measure ran at least once.
    const all = generateBrief(everything());
    const withEvidence = new Set(all.scored.map((s) => s.kind));
    // catchup needs a catch-up day and oneThing at most two decisions; both are covered above.
    for (const e of CATALOGUE) if (e.id !== "catchup" && e.id !== "oneThing") expect(withEvidence.has(e.id), `${e.id} measured`).toBe(true);
    expect(generateBrief(catchUpThursday()).scored.map((s) => s.kind)).toEqual(expect.arrayContaining(["catchup", "oneThing"]));
  });

  it("the lint itself catches what the owner rejected", () => {
    expect(lintReason("Shown because indigoai-us/hq-core is red.")).toBe("repo slug");
    expect(lintReason("Shown because PR #1201 merged.")).toBe("PR or issue number");
    expect(lintReason("Shown because feat(brief): landed.")).toBe("conventional prefix");
    expect(lintReason("Shown because. It did.")).toBe("more than one sentence");
    expect(lintReason(`Shown because ${"x".repeat(170)}.`)).toMatch(/too long/);
    expect(lintReason("Shown because the file src/brief/x.ts changed.")).toBe("path");
    expect(lintReason('Shown for priority 1, "Keep the rule?": it waits on you.')).toBeNull();
  });

  it("digest returns one content hash per entry with evidence, and an unchanged tier-3 card loses five points", () => {
    const d = digest(octoberEleven());
    expect(d.sunrise).toBe("sunrise");
    expect(d.needs).toBe("d1|d2|d3|d4|d5");
    expect(d.meetings).toBeUndefined();
    const plan = generateBrief({ ...octoberEleven(), previous: { runId: "prev", hashes: d } });
    expect(plan.widgets.find((w) => w.kind === "shipped")!.score).toBe(25);
    expect(plan.widgets.find((w) => w.kind === "needs")!.score).toBe(generateBrief(octoberEleven()).widgets.find((w) => w.kind === "needs")!.score);
  });

  it("density: strong cards count, value-1 cards only top up to four, never above the pool", () => {
    const ctx = buildContext(octoberEleven());
    const pool = eligible(ctx, []);
    expect(density(ctx, pool)).toBe(6);
    expect(density(ctx, pool.slice(0, 2))).toBe(2);
    const dropped: Dropped[] = [];
    eligible(buildContext({ ...octoberEleven(), prefs: { density: "auto", pinned: [], hidden: ["risk"], weights: {} } }), dropped);
    expect(dropped).toContainEqual({ kind: "risk", why: "hidden by you" });
    expect(leadReason(ctx, "x")).toBe('"Close out the $20-cap SAFE allotment" leads · x');
    expect(pick(ctx, pool).template).toBe("6B");
  });
});
