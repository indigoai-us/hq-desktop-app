import { describe, expect, it } from "vitest";
import {
  BRIEF_ROW_MIN_PX,
  FITS,
  MAX_DENSITY,
  MIN_DENSITY,
  TEMPLATES,
  generateBrief,
  gridStyle,
  place,
  summarizeSessions,
} from "./brief-generate.js";
import { VARIANTS, entryOf } from "./brief-catalogue.js";
import { catchUpThursday, octoberEleven } from "./brief-catalogue-fixtures.js";
import { octoberEightBrief } from "./brief-fixture.js";
import type { BriefInput } from "./brief-types.js";

describe("gridStyle", () => {
  it("live: the plan's areas with rows that start at the minimum and grow", () => {
    const style = gridStyle(["a a a b b c", "a a a b b d"], false);
    expect(style).toBe(`grid-template-rows:repeat(2, minmax(${BRIEF_ROW_MIN_PX}px, auto));grid-template-areas:'a a a b b c' 'a a a b b d'`);
  });

  it("review: source-order row flow, never dense (a later group's card must not climb above an earlier label), label rows sized to content", () => {
    const style = gridStyle(["a a a b b c"], true);
    expect(style).toBe("grid-auto-flow:row;grid-auto-rows:auto;grid-template-rows:none");
    expect(style).not.toContain("dense");
    expect(style).not.toContain(`${BRIEF_ROW_MIN_PX}px`);
  });
});

const NOW = new Date("2026-10-08T14:40:00.000Z");

function quietDay(): BriefInput {
  return {
    now: NOW.toISOString(),
    today: "2026-10-08",
    userName: "Corey",
    companies: ["cmp_indigo"],
    calendarToday: [],
    meetingsYesterday: [],
    decisions: [],
    actionItems: [],
    risks: [],
    shipped: [],
    waitingOn: [],
    team: [],
    sessions: [],
    lastBriefAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
  };
}

const full = () => ({ ...octoberEightBrief(NOW), today: "2026-10-08" });

describe("generateBrief: lead", () => {
  it("leads with decisions when several calls wait, even with an incident, and quotes priority 1", () => {
    const plan = generateBrief(full());
    expect(plan.lead).toBe("decisions");
    expect(plan.reason).toBe('"Cut the hq-core release" leads · 4 calls and a live incident');
    expect(plan.leadPriority).toMatchObject({ text: "Cut the hq-core release", itemId: "d1" });
  });

  it("leads with the incident when it is live and few calls wait", () => {
    const input = { ...full(), decisions: full().decisions.slice(0, 1) };
    const plan = generateBrief(input);
    expect(plan.lead).toBe("incident");
    expect(plan.widgets.map((w) => w.kind)).toContain("incident");
  });

  it("leads with momentum when nothing is owed and work shipped", () => {
    const input = { ...full(), decisions: [], risks: [] };
    const plan = generateBrief(input);
    expect(plan.lead).toBe("momentum");
    expect(plan.reason).toBe("6 things shipped yesterday");
    expect(plan.leadPriority).toBeNull();
    expect(plan.widgets.map((w) => w.kind)).toContain("shipped");
  });

  it("leads with your day on a quiet day: the hero alone, no holes", () => {
    const plan = generateBrief(quietDay());
    expect(plan.lead).toBe("your-day");
    expect(plan.reason).toBe("a quiet day");
    expect(plan.widgets.map((w) => w.kind)).toEqual(["sunrise"]);
    expect(plan.template).toBe("1");
    expect(plan.areas.join(" ")).not.toContain(".");
  });

  it("switches to catch-up after three or more days away", () => {
    const input = { ...full(), lastBriefAt: new Date(NOW.getTime() - 5 * 86_400_000).toISOString() };
    const plan = generateBrief(input);
    expect(plan.lead).toBe("catch-up");
    expect(plan.dayType).toBe("catch-up");
    expect(plan.reason).toBe('"Cut the hq-core release" leads · you were away 5 days');
    expect(plan.density).toBeLessThanOrEqual(5);
    expect(plan.widgets[0]).toMatchObject({ kind: "catchup", size: "XL", slot: "a" });
    expect(plan.daysAway).toBe(5);
  });

  it("does not catch up after two days away or on a first brief", () => {
    const two = { ...full(), lastBriefAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() };
    expect(generateBrief(two).lead).toBe("decisions");
    expect(generateBrief({ ...full(), lastBriefAt: null }).lead).toBe("decisions");
  });
});

describe("generateBrief: density and placement", () => {
  it("gives the Oct 8 preview day eight widgets on template 8, each in a slot it fits, each with a reason", () => {
    const plan = generateBrief(full());
    expect(plan.template).toBe("8");
    expect(plan.density).toBe(8);
    expect(plan.widgets).toHaveLength(8);
    for (const w of plan.widgets) expect(FITS[w.kind]).toContain(w.size);
    // Focus time serves priority 1 (a clear stretch for it) and takes the W3 beside shipped; Today's calls
    // fold into it (pair rule), and Team, value 1, finds no room.
    expect(plan.widgets.map((w) => w.kind)).toEqual(["sunrise", "needs", "incident", "waiting", "meetings", "risk", "shipped", "runway"]);
    for (const w of plan.widgets) expect(w.reason).toMatch(/^(Always first|Shown)\b.*\.$/);
    expect(plan.widgets.find((w) => w.kind === "needs")).toMatchObject({ tier: 2, rows: 2 });
    expect(plan.widgets.find((w) => w.kind === "incident")).toMatchObject({ tier: 2, size: "S" });
    expect(plan.widgets.find((w) => w.kind === "runway")).toMatchObject({ tier: 3, size: "W3" });
    expect(plan.widgets.find((w) => w.kind === "runway")!.reason).toMatch(/^Shown for priority 1, "Cut the hq-core release": .* clear after .* fits it\.$/);
    expect(plan.dropped).toEqual(
      expect.arrayContaining([
        { kind: "agenda", why: "Focus time already shows today's calls and gaps" },
        { kind: "team", why: "no room at 8 widgets" },
      ]),
    );
    expect(plan.explain.length).toBe(plan.widgets.length + plan.dropped.length);
  });

  it("the Oct 11 run with the whole catalogue built: template 7, focus beside team; the catch-up Thursday is the spec's template 5", () => {
    const sunday = generateBrief(octoberEleven());
    expect(sunday.template).toBe("7");
    expect(sunday.widgets.map((w) => w.kind)).toEqual(["sunrise", "needs", "incident", "risk", "shipped", "team", "focus"]);
    // Firsts (one first, value 1) is a weekend filler; blockedByMe has no edges and decided's meetings are two days old, so neither measures.
    expect(sunday.dropped).toEqual([{ kind: "firsts", why: "a weekend filler; it comes back Monday" }]);
    expect(sunday.scored.map((s) => s.kind)).not.toContain("blockedByMe");
    expect(sunday.scored.map((s) => s.kind)).not.toContain("decided");
    const thursday = generateBrief(catchUpThursday());
    expect(thursday.template).toBe("5");
    expect(thursday.areas).toEqual([
      "catchup catchup catchup needs needs meetings",
      "catchup catchup catchup needs needs carry",
      "catchup catchup catchup weekArc weekArc weekArc",
    ]);
    expect(thursday.widgets.map((w) => [w.kind, w.size])).toEqual([
      ["catchup", "XL"],
      ["needs", "M"],
      ["meetings", "S"],
      ["carry", "S"],
      ["weekArc", "W3"],
    ]);
  });

  it("never gives a widget a full-height single column", () => {
    for (let n = MIN_DENSITY; n <= MAX_DENSITY; n += 1) {
      for (const w of place(n, Object.keys(FITS) as (keyof typeof FITS)[]).widgets) {
        expect(w.cols === 1 && w.rows > 1).toBe(false);
      }
    }
  });

  it("stays between 1 and 8 widgets with 2 or 3 rows of six cells and no holes", () => {
    const days: BriefInput[] = [quietDay(), full(), { ...full(), decisions: [] }, { ...full(), shipped: [], risks: [] }];
    for (const day of days) {
      const plan = generateBrief(day);
      expect(plan.density).toBeGreaterThanOrEqual(1);
      expect(plan.density).toBeLessThanOrEqual(MAX_DENSITY);
      expect(plan.density).toBe(plan.widgets.length);
      expect(plan.areas.length).toBeGreaterThanOrEqual(2);
      expect(plan.areas.length).toBeLessThanOrEqual(3);
      for (const row of plan.areas) {
        expect(row.split(" ")).toHaveLength(6);
        expect(row).not.toContain(".");
      }
    }
  });

  it("grows with what earned a slot", () => {
    expect(generateBrief(quietDay()).density).toBeLessThan(generateBrief(full()).density);
    const lighter = { ...full(), waitingOn: [], calendarToday: [] };
    expect(generateBrief(lighter).density).toBeLessThan(generateBrief(full()).density);
  });

  it("places a template's areas so every widget's span matches its slot", () => {
    const { areas, widgets } = place(5, ["catchup", "needs", "agenda", "incident", "shipped"]);
    expect(areas).toEqual([
      "catchup catchup catchup needs needs agenda",
      "catchup catchup catchup needs needs incident",
      "catchup catchup catchup shipped shipped shipped",
    ]);
    expect(widgets.find((w) => w.kind === "catchup")).toMatchObject({ cols: 3, rows: 3 });
    expect(widgets.find((w) => w.kind === "agenda")).toMatchObject({ size: "S", cols: 1, rows: 1 });
    expect(widgets.find((w) => w.kind === "shipped")).toMatchObject({ size: "W3", cols: 3, rows: 1 });
  });

  it("has a template variant for every density from 1 to 8", () => {
    for (let n = 1; n <= MAX_DENSITY; n += 1) {
      expect(VARIANTS[n]!.length).toBeGreaterThan(0);
      for (const name of VARIANTS[n]!) expect(Object.keys(TEMPLATES[name]!.cls)).toHaveLength(n);
    }
  });

  it("carries the review-mode fields: every entry with evidence is scored, and an unbuilt one is dropped with what it would say", () => {
    const plan = generateBrief(full());
    expect(plan.scored.map((s) => s.kind)).toEqual(expect.arrayContaining(["sunrise", "needs", "incident", "risk", "team", "runway", "agenda", "blockedByMe"]));
    for (const s of plan.scored) expect(s.entry.ready).toBe(true);
    expect(plan.dropped.find((d) => d.kind === "runway")).toBeUndefined();
    // The not-built path stays for the next entry without a card.
    const runway = entryOf("runway") as { ready: boolean };
    runway.ready = false;
    try {
      const unbuilt = generateBrief(full());
      expect(unbuilt.scored.find((s) => s.kind === "runway")?.entry.ready).toBe(false);
      expect(unbuilt.dropped.find((d) => d.kind === "runway")?.why).toMatch(/^no card yet; it would say: .* clear after /);
      expect(unbuilt.widgets.map((w) => w.kind)).toContain("agenda");
    } finally {
      runway.ready = true;
    }
  });
});

describe("other-company sessions", () => {
  const sessions = [
    { id: "1", title: "Bot parity", startedAt: NOW.toISOString(), workstream: "HQ core", company: "cmp_indigo" },
    { id: "2", title: "Acme pricing secret plan", startedAt: NOW.toISOString(), workstream: "Acme deals", company: "cmp_acme" },
    { id: "3", title: "Acme launch", startedAt: NOW.toISOString(), workstream: "Acme deals", company: "cmp_acme" },
  ];

  it("counts sessions outside the brief's companies without their titles or workstreams", () => {
    const summary = summarizeSessions(sessions, ["cmp_indigo"]);
    expect(summary.count).toBe(1);
    expect(summary.otherCompanyCount).toBe(2);
    const text = JSON.stringify(summary);
    expect(text).not.toContain("Acme");
  });

  it("never carries another company's session titles into the plan, and has no other-company card", () => {
    const plan = generateBrief({ ...quietDay(), sessions });
    const text = JSON.stringify(plan);
    expect(text).not.toContain("Acme");
    expect(plan.sessions.otherCompanyCount).toBe(2);
    expect(plan.widgets.map((w) => w.kind)).not.toContain("otherWork");
    expect(Object.keys(FITS)).not.toContain("otherWork");
    expect(Object.keys(FITS)).not.toContain("fleet");
  });
});
