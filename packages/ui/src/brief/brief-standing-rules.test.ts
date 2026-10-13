// @vitest-environment happy-dom
/**
 * Standing rules from the catalogue spec, section 12, as tests: no fleet or
 * other-company card exists; the hero is always slot a; no '.' cells while
 * QUIET_TEMPLATES is on; density never above 8; the Priorities section renders
 * whenever it has rows and never otherwise; lists cap at five; owner feedback
 * reaches the picker only through prefs (pinned, hidden, weights) with the
 * plain-language teaching maps the writer uses; sunrise, catchup and needs can
 * never be hidden. Runs on the synthetic fixture days and the TS fixtures.
 */

import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { CATALOGUE, CATCH_UP_DENSITY, MAX_DENSITY, PAIRS, QUIET_TEMPLATES, TEMPLATES, buildContext, eligible, normalizePrefs } from "./brief-catalogue.js";
import { catchUpThursday as tsCatchUp, everything, octoberEleven as tsOctoberEleven, quietSaturday as tsQuietSaturday } from "./brief-catalogue-fixtures.js";
import { FITS, generateBrief } from "./brief-generate.js";
import { DEFAULT_PREFS, NEVER_HIDDEN, parsePrefs } from "./brief-run-files.js";
import type { BriefInput, BriefWidgetKind } from "./brief-types.js";
import oct11Json from "./fixtures/brief-2026-10-11.json";
import oct15Json from "./fixtures/brief-2026-10-15.json";
import oct17Json from "./fixtures/brief-2026-10-17.json";

const load = (json: unknown): BriefInput => JSON.parse(JSON.stringify(json)) as BriefInput;
const DAYS: [string, () => BriefInput][] = [
  ["Oct 11 fixture", () => load(oct11Json)],
  ["Oct 15 fixture", () => load(oct15Json)],
  ["Oct 17 fixture", () => load(oct17Json)],
  ["Oct 11 (ts)", tsOctoberEleven],
  ["Oct 15 (ts)", tsCatchUp],
  ["Oct 17 (ts)", tsQuietSaturday],
  ["everything", everything],
];
const COMPANIES = [{ uid: "cmp_northwind", slug: "northwind", label: "Northwind", iconUrl: null }];

let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;
function render(input: BriefInput) {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(DailyBrief, { target, props: { input, companies: COMPANIES } });
  flushSync();
}
const q = (sel: string) => target.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
});

describe("standing rules (spec section 12)", () => {
  it("no fleet or otherWork kind exists: not in the catalogue, FITS, the pairs, or as a component file", () => {
    for (const k of ["fleet", "otherWork"]) {
      expect(CATALOGUE.map((e) => e.id)).not.toContain(k);
      expect(Object.keys(FITS)).not.toContain(k);
      expect(PAIRS.flatMap((r) => r.pair)).not.toContain(k);
    }
    const here = new URL(".", import.meta.url);
    expect(existsSync(new URL("BriefFleet.svelte", here))).toBe(false);
    expect(existsSync(new URL("BriefOtherWork.svelte", here))).toBe(false);
    for (const [name, make] of DAYS) {
      const plan = generateBrief(make());
      expect(plan.widgets.map((w) => w.kind), name).not.toContain("fleet");
      expect(plan.widgets.map((w) => w.kind), name).not.toContain("otherWork");
    }
  });

  it("hero always in slot a; no '.' in areas when QUIET_TEMPLATES; density between 1 and 8, five at most on a catch-up day", () => {
    expect(QUIET_TEMPLATES).toBe(true);
    for (const row of Object.values(TEMPLATES).flatMap((t) => t.areas)) expect(row).not.toContain(".");
    for (const [name, make] of DAYS) {
      const plan = generateBrief(make());
      expect(plan.widgets[0]!.slot, name).toBe("a");
      expect(plan.widgets[0]!.tier, name).toBe(1);
      expect(plan.areas[0]!.split(" ")[0], name).toBe(plan.widgets[0]!.kind);
      for (const row of plan.areas) expect(row, name).not.toContain(".");
      expect(plan.density, name).toBeGreaterThanOrEqual(1);
      expect(plan.density, name).toBeLessThanOrEqual(MAX_DENSITY);
      expect(plan.density, name).toBe(plan.widgets.length);
      if (plan.dayType === "catch-up") expect(plan.density, name).toBeLessThanOrEqual(CATCH_UP_DENSITY);
    }
  });

  it("the Priorities section renders above the grid whenever it has rows, and not at all when it has none", () => {
    render(load(oct11Json));
    const card = q('[data-testid="brief-priorities"]')!;
    expect(card).not.toBeNull();
    expect(qa('[data-testid="brief-priority"]')).toHaveLength(5);
    expect(card.compareDocumentPosition(q("main.b-grid")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount(app!);
    app = null;
    target.remove();
    render(load(oct17Json));
    expect(q('[data-testid="brief-priorities"]')).toBeNull();
    expect(q("main.b-grid")).not.toBeNull();
  });

  it("every list shows at most five rows: seven priorities render five; the plan's widgets never exceed what the template seats", () => {
    const day = load(oct11Json);
    day.priorities = Array.from({ length: 7 }, (_, i) => ({ n: i + 1, text: `Priority ${i + 1}`, because: null, itemId: i < 5 ? day.decisions[i]!.id : null }));
    render(day);
    expect(qa('[data-testid="brief-priority"]')).toHaveLength(5);
    // Needs you with seven calls: five rows, then "+2 more".
    unmount(app!);
    app = null;
    target.remove();
    const busy = load(oct11Json);
    busy.decisions.push(
      { ...busy.decisions[0]!, id: "d6", title: "Approve the second pilot" },
      { ...busy.decisions[1]!, id: "d7", title: "Answer Blake on the roadmap" },
    );
    render(busy);
    expect(qa('[data-testid="brief-need"]')).toHaveLength(5);
    expect(q('[data-testid="brief-need-more"]')!.textContent!.trim()).toBe("+2 more");
  });

  it("owner feedback reaches the picker only through prefs: the writer's keys map to pinned, hidden and weights", () => {
    // "always show runway" -> pinned_widgets; "never show focus" -> muted_widgets; "fewer team cards" -> widget_weights.team: -1.
    expect(parsePrefs({ pinned_widgets: ["runway"], muted_widgets: ["focus"], widget_weights: { team: -1 }, density: "auto" })).toEqual({
      density: "auto",
      pinned: ["runway"],
      hidden: ["focus"],
      weights: { team: -1 },
    });
    expect(parsePrefs({ pinned: ["runway"], muted: ["focus"], weights: { team: -1 } })).toEqual({ density: "auto", pinned: ["runway"], hidden: ["focus"], weights: { team: -1 } });
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
    // Weights are clamped to two steps either way; unknown kinds are dropped.
    expect(parsePrefs({ widget_weights: { team: -9, shipped: 9, bogus: 1 } }).weights).toEqual({ team: -2, shipped: 2 });
  });

  it("pinned: tier 2 below the priority containers; hidden: excluded and listed; weights: five points a step", () => {
    const day = load(oct11Json);
    const pinned = generateBrief({ ...day, prefs: { density: "auto", pinned: ["firsts"], hidden: [], weights: {} } });
    const order = pinned.scored.map((s) => s.kind);
    expect(order.slice(0, 4)).toEqual(["sunrise", "needs", "incident", "firsts"]);
    expect(pinned.scored[3]).toMatchObject({ tier: 2, why: { kind: "pref" } });
    expect(pinned.widgets.find((w) => w.kind === "firsts")!.reason).toBe("Shown because you asked for it always; 3 firsts shipped yesterday.");

    const hidden = generateBrief({ ...day, prefs: { density: "auto", pinned: [], hidden: ["firsts"], weights: {} } });
    expect(hidden.widgets.map((w) => w.kind)).not.toContain("firsts");
    expect(hidden.scored.map((s) => s.kind)).not.toContain("firsts");
    expect(hidden.dropped).toEqual(expect.arrayContaining([{ kind: "firsts", why: "hidden by you" }, { kind: "blockedByMe", why: "no room at 6 widgets" }]));
    // With Firsts gone the day has five strong cards and fills 6B, the spec's page; What your calls unblock (value 1) still finds no room.
    expect(hidden.template).toBe("6B");
    expect(hidden.widgets.map((w) => w.kind)).toEqual(["sunrise", "needs", "incident", "risk", "shipped", "team"]);

    const fewer = eligible(buildContext({ ...day, prefs: { density: "auto", pinned: [], hidden: [], weights: { team: -1, risk: 2, shipped: -5 } } }), []);
    expect(fewer.find((s) => s.kind === "team")!.score).toBe(21);
    expect(fewer.find((s) => s.kind === "risk")!.score).toBe(40);
    expect(fewer.find((s) => s.kind === "shipped")!.score).toBe(20); // clamped to -2 steps
  });

  it("sunrise, catchup and needs cannot be hidden: the parser and the generator both ignore it", () => {
    expect(NEVER_HIDDEN).toEqual(["sunrise", "catchup", "needs"]);
    expect(parsePrefs({ muted: ["sunrise", "catchup", "needs", "team"] }).hidden).toEqual(["team"]);
    expect(normalizePrefs({ density: "auto", pinned: [], hidden: ["sunrise", "catchup", "needs", "team"], weights: {} }).hidden).toEqual(["team"]);
    const day = load(oct11Json);
    const plan = generateBrief({ ...day, prefs: { density: "auto", pinned: [], hidden: ["sunrise", "needs", "catchup"] as BriefWidgetKind[], weights: {} } });
    expect(plan.widgets.map((w) => w.kind)).toEqual(expect.arrayContaining(["sunrise", "needs"]));
    expect(plan.dropped.filter((d) => d.why === "hidden by you")).toEqual([]);
  });

  it("hiding Incident is the owner's call: its priority loses its card and the dropped list says so (the Priorities section still shows it)", () => {
    const day = load(oct11Json);
    const plan = generateBrief({ ...day, prefs: { density: "auto", pinned: [], hidden: ["incident"], weights: {} } });
    expect(plan.widgets.map((w) => w.kind)).not.toContain("incident");
    expect(plan.dropped).toEqual(expect.arrayContaining([{ kind: "incident", why: "hidden by you" }, { kind: "priority-5", why: "priority 5 has no card; shown in the list above" }]));
    render({ ...day, prefs: { density: "auto", pinned: [], hidden: ["incident"], weights: {} } });
    expect(qa('[data-testid="brief-priority"]')).toHaveLength(5);
    expect(q('[data-widget="incident"]')).toBeNull();
  });

  it("a catch-up day with one strong card besides the hero keeps it: the Welcome back hero takes template 2 at L", () => {
    // Four days away, two calls, nothing else: the hero's tiles carry both calls and Needs you still gets its slot.
    const day = load(oct15Json);
    const quiet: BriefInput = {
      ...day,
      risks: [],
      meetingsYesterday: [],
      carry: undefined,
      handoffs: undefined,
      recovered: undefined,
      days: undefined,
      shipped: [],
      merged: 0,
      prefs: { density: "auto", pinned: [], hidden: ["oneThing"], weights: {} },
    };
    const plan = generateBrief(quiet);
    expect(plan.dayType).toBe("catch-up");
    expect(plan.template).toBe("2");
    expect(plan.widgets.map((w) => [w.kind, w.size, w.slot])).toEqual([
      ["catchup", "L", "a"],
      ["needs", "L", "b"],
    ]);
    expect(plan.areas).toEqual(["catchup catchup catchup needs needs needs", "catchup catchup catchup needs needs needs"]);
  });
});
