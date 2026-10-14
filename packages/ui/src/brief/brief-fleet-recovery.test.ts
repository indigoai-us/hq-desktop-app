// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import Harness from "./BriefFleetRecoveryHarness.test-support.svelte";
import {
  CHART,
  FLEET_LIST_CAP,
  VERDICT_RULE,
  agentPromptKey,
  fleetGeometry,
  fleetRecoveryVisible,
  heroMeta,
  initialOf,
  inspectPrompt,
  monoWidth,
  peakOf,
  pillSpot,
  pillText,
  placeAxisLabels,
  placePinLabels,
  readingDots,
  stuckFor,
  stuckList,
  stuckOld,
  verdictTitle,
} from "./brief-fleet-recovery.js";
import type { BriefFleetIncident, BriefOrigin } from "./brief-types.js";

const NOW = "2026-10-11T14:54:00.000Z";
const H = 3_600_000;
const ago = (h: number) => new Date(Date.parse(NOW) - h * H).toISOString();
const ORIGIN: BriefOrigin = { companyUid: "cmp_indigo", repo: "indigoai-us/hq-cloud", product: "HQ Cloud" };

/** The Oct 8 rescue, shaped as the writer would hand it over: 86 stuck at the peak, 9 still stuck. */
function incident(extra: Partial<BriefFleetIncident> = {}): BriefFleetIncident {
  return {
    id: "fi1",
    series: [
      { at: ago(47), stuck: 0 },
      { at: ago(30), stuck: 0 },
      { at: ago(26), stuck: 86 },
      { at: ago(20), stuck: 86 },
      { at: ago(16), stuck: 40 },
      { at: ago(8), stuck: 12 },
      { at: ago(1), stuck: 9 },
    ],
    incidentStart: ago(28),
    incidentEnd: null,
    verdict: "healing",
    stillStuck: [
      { name: "scout", reason: "disk_full", since: ago(27) },
      { name: "atlas", reason: "disk_full", since: ago(26) },
      { name: "nimbus", reason: "setup", since: ago(25) },
      { name: "quill", reason: "disk_full", since: null },
      { name: "ember", reason: "disk_full", since: ago(20) },
      { name: "orbit", reason: "setup", since: ago(18) },
      { name: "pixel", reason: "disk_full", since: ago(12) },
      { name: "lumen", reason: "disk_full", since: ago(10) },
      { name: "sable", reason: "setup", since: ago(6) },
    ],
    fixes: [
      { label: "hq-cloud #913: fix(fleet): free the disk on setup boxes", at: ago(18), origin: ORIGIN },
      { label: "hq-pro-agents #1132: retry setup after a disk rescue", at: ago(15), origin: { ...ORIGIN, repo: "indigoai-us/hq-pro-agents", product: "Fleet agents" } },
    ],
    ...extra,
  };
}

const nums = (d: string) => d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
const xs = (d: string) => nums(d).filter((_, i) => i % 2 === 0);

describe("gate", () => {
  it("shows while the incident is open or closed within the last 24 hours, and never after", () => {
    expect(fleetRecoveryVisible(incident(), NOW)).toBe(true);
    expect(fleetRecoveryVisible(incident({ incidentEnd: ago(23) }), NOW)).toBe(true);
    expect(fleetRecoveryVisible(incident({ incidentEnd: ago(25) }), NOW)).toBe(false);
    expect(fleetRecoveryVisible(incident({ incidentEnd: "not a date" }), NOW)).toBe(true);
    expect(fleetRecoveryVisible(null, NOW)).toBe(false);
    expect(fleetRecoveryVisible(undefined, NOW)).toBe(false);
  });
});

describe("verdict title", () => {
  it("is verdict-first with the still-stuck count and never a total", () => {
    expect(verdictTitle(incident())).toBe("Healing · 9 agents still stuck");
    expect(verdictTitle(incident({ verdict: "plateaued", stillStuck: incident().stillStuck.slice(0, 4) }))).toBe("Plateaued · 4 agents still stuck");
    expect(verdictTitle(incident({ verdict: "relapsing", stillStuck: incident().stillStuck.slice(0, 1) }))).toBe("Relapsing · 1 agent still stuck");
    expect(verdictTitle(incident({ verdict: "healed", stillStuck: [] }))).toBe("Healed · no agent still stuck");
    expect(VERDICT_RULE).toMatch(/^Healing = .*Healed = .*Plateaued = .*Relapsing = /);
  });
});

describe("curve geometry", () => {
  it("spans the whole 48h window, with the red area only inside the incident window", () => {
    const g = fleetGeometry(incident(), NOW);
    expect(g.to - g.from).toBe(48 * H);
    expect(g.max).toBe(86);
    const lineX = xs(g.line);
    expect(lineX[0]).toBe(CHART.left);
    expect(lineX[lineX.length - 1]).toBe(CHART.w - CHART.right);
    // Points are in time order and inside the box.
    for (let i = 1; i < lineX.length; i += 1) expect(lineX[i]!).toBeGreaterThanOrEqual(lineX[i - 1]!);
    for (const p of g.points) {
      expect(p.y).toBeGreaterThanOrEqual(CHART.top);
      expect(p.y).toBeLessThanOrEqual(g.baseY);
    }
    expect(g.area).not.toBeNull();
    const startX = g.x(Date.parse(ago(28)));
    expect(g.incident).toEqual({ x0: startX, x1: CHART.w - CHART.right });
    for (const x of xs(g.area!)) expect(x).toBeGreaterThanOrEqual(startX - 0.01);
    // Outside the incident window the curve is a hairline only: the quiet first 20 hours sit on the baseline.
    const quiet = g.points.filter((p) => p.at < Date.parse(ago(30)));
    expect(quiet.length).toBeGreaterThan(0);
    for (const p of quiet) expect(p.y).toBe(g.baseY);
  });

  it("closes the red area at the incident end, drops it without a start, and clips to the window", () => {
    const closed = fleetGeometry(incident({ incidentEnd: ago(4) }), NOW);
    expect(closed.incident!.x1).toBeCloseTo(closed.x(Date.parse(ago(4))), 6);
    for (const x of xs(closed.area!)) expect(x).toBeLessThanOrEqual(closed.incident!.x1 + 0.01);
    expect(fleetGeometry(incident({ incidentStart: null }), NOW).area).toBeNull();
    const old = fleetGeometry(incident({ incidentStart: ago(72) }), NOW);
    expect(old.incident!.x0).toBe(CHART.left);
    expect(fleetGeometry(incident({ incidentStart: ago(72), incidentEnd: ago(60) }), NOW).area).toBeNull();
  });

  it("holds the first and last values at the window edges and interpolates between points", () => {
    const g = fleetGeometry(incident({ series: [{ at: ago(10), stuck: 20 }, { at: ago(2), stuck: 4 }] }), NOW);
    const at = (h: number) => g.points.find((p) => p.at === Date.parse(ago(h)))!;
    expect(at(48).stuck).toBe(20);
    expect(at(0).stuck).toBe(4);
    const mid = g.points.find((p) => p.at === Date.parse(ago(28)));
    expect(mid?.stuck ?? 20).toBe(20);
    const g2 = fleetGeometry(incident({ series: [{ at: ago(10), stuck: 20 }, { at: ago(2), stuck: 4 }], incidentStart: ago(6), incidentEnd: null }), NOW);
    expect(g2.points.find((p) => p.at === Date.parse(ago(6)))!.stuck).toBe(12);
  });

  it("pins fixes inside the window in time order with plain labels, and drops older fixes", () => {
    const g = fleetGeometry(incident({ fixes: [...incident().fixes, { label: "hq-cloud #800: old fix", at: ago(60), origin: ORIGIN }] }), NOW);
    expect(g.pins.map((p) => p.label)).toEqual(["Free the disk on setup boxes", "Retry setup after a disk rescue"]);
    expect(g.pins[0]!.x).toBeLessThan(g.pins[1]!.x);
    expect(g.pins.map((p) => p.index)).toEqual([0, 1]);
    for (const p of g.pins) expect(p.label).not.toMatch(/#\d+|\w+\/\w+|^fix\(/);
  });

  it("survives an empty or junk series", () => {
    const g = fleetGeometry(incident({ series: [], fixes: [] }), NOW);
    expect(g.max).toBe(1);
    expect(g.line).toMatch(/^M/);
    expect(g.pins).toEqual([]);
    const j = fleetGeometry(incident({ series: [{ at: "nope", stuck: 3 }] }), NOW);
    expect(j.points.every((p) => p.stuck === 0)).toBe(true);
  });

  it("names the peak", () => {
    expect(peakOf(incident().series)).toEqual({ stuck: 86, at: ago(26) });
    expect(peakOf([])).toBeNull();
  });
});

describe("stuck list", () => {
  it("shows five, longest stuck first with unknown since last, and folds the rest", () => {
    const { shown, rest } = stuckList(incident().stillStuck);
    expect(shown).toHaveLength(FLEET_LIST_CAP);
    expect(shown.map((a) => a.name)).toEqual(["scout", "atlas", "nimbus", "ember", "orbit"]);
    expect(rest.map((a) => a.name)).toEqual(["pixel", "lumen", "sable", "quill"]);
    expect(stuckList([]).shown).toEqual([]);
  });

  it("says how long an agent has been stuck without a locale", () => {
    const nowMs = Date.parse(NOW);
    expect(stuckFor(ago(40), nowMs)).toBe("40h");
    expect(stuckFor(ago(72), nowMs)).toBe("3d");
    expect(stuckFor(new Date(nowMs - 20 * 60_000).toISOString(), nowMs)).toBe("20 min");
    expect(stuckFor(null, nowMs)).toBe("");
    expect(stuckFor("junk", nowMs)).toBe("");
    expect(stuckFor(ago(-2), nowMs)).toBe("");
  });

  it("writes a read-only inspect prompt per agent, keyed on the incident and name", () => {
    const a = incident().stillStuck[0]!;
    const p = inspectPrompt(a, incident());
    expect(p).toContain('"scout"');
    expect(p).toContain("disk_full");
    expect(p).toContain("read-only");
    expect(p).toMatch(/Do not change, restart, redeploy or message anything\.$/);
    expect(agentPromptKey("fi1", "scout")).toBe("fi1:scout");
  });
});

describe("hero", () => {
  it("says where the count came down from and how long the incident has run, never a total", () => {
    const nowMs = Date.parse(NOW);
    expect(heroMeta(incident(), nowMs)).toBe("down from 86 · open 28h");
    expect(heroMeta(incident({ incidentEnd: ago(2), stillStuck: [] }), nowMs)).toBe("down from 86 · closed 2h ago");
    // Still at the top of the curve: no "down from".
    expect(heroMeta(incident({ series: [{ at: ago(3), stuck: 2 }], stillStuck: incident().stillStuck.slice(0, 2) }), nowMs)).toBe("at its peak · open 28h");
    expect(heroMeta(incident({ series: [], incidentStart: null }), nowMs)).toBe("");
    expect(heroMeta(incident(), nowMs)).not.toMatch(/\bof \d+/);
  });

  it("marks an agent old once it has been stuck a day, and draws an initial for its circle", () => {
    const nowMs = Date.parse(NOW);
    expect(stuckOld(ago(24), nowMs)).toBe(true);
    expect(stuckOld(ago(23), nowMs)).toBe(false);
    expect(stuckOld(null, nowMs)).toBe(false);
    expect(stuckOld("junk", nowMs)).toBe(false);
    expect(initialOf("scout")).toBe("S");
    expect(initialOf("  _atlas")).toBe("A");
    expect(initialOf("")).toBe("?");
  });
});

describe("chart layout", () => {
  const overlap = (a: { left: number; w: number }, b: { left: number; w: number }) => a.left < b.left + b.w && b.left < a.left + a.w;

  it("pins now to the right edge and drops a weekday that would touch it", () => {
    const w = 300;
    const labels = placeAxisLabels([{ x: 120, label: "Tue" }, { x: 285, label: "Wed" }], w);
    expect(labels.map((l) => l.label)).toEqual(["Tue", "now"]);
    const now = labels[labels.length - 1]!;
    expect(now.left + now.w).toBe(w);
    // A tick at the very left edge is held inside the axis.
    expect(placeAxisLabels([{ x: 0, label: "Mon" }], w)[0]!.left).toBe(0);
  });

  it("never lets two axis labels share an x or overlap, at any width", () => {
    const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let width = 80; width <= 640; width += 17) {
      for (let k = 0; k < 12; k += 1) {
        const ticks = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, i) => ({ x: rnd() * width, label: DAYS[(k + i) % 7]! }));
        const labels = placeAxisLabels(ticks, width);
        expect(labels[labels.length - 1]!.label).toBe("now");
        for (const l of labels) {
          expect(l.left).toBeGreaterThanOrEqual(0);
          expect(l.left + l.w).toBeLessThanOrEqual(Math.max(width, l.w) + 0.001);
        }
        for (let i = 0; i < labels.length; i += 1)
          for (let j = i + 1; j < labels.length; j += 1) {
            const a = labels[i]!;
            const b = labels[j]!;
            expect(overlap({ left: a.left - 5, w: a.w + 10 }, b), `${a.label}@${a.left} vs ${b.label}@${b.left} in ${width}px`).toBe(false);
          }
      }
    }
  });

  it("stacks fix labels in two lines, keeps them off a reserved box, and leaves a pin bare when there is no room", () => {
    const w = 300;
    const two = placePinLabels([{ x: 100, label: "Fix 12 PM" }, { x: 114, label: "Fix 3 PM" }], w);
    expect(two.map((s) => s.row)).toEqual([0, 1]);
    // Near the right edge a label ends left of its pin instead of running off the plot.
    const edge = placePinLabels([{ x: 296, label: "Fix 3 PM" }], w)[0]!;
    expect(edge.left + edge.w).toBeLessThanOrEqual(296);
    // The value pill holds the first line: the label moves down a line.
    expect(placePinLabels([{ x: 100, label: "Fix 12 PM" }], w, [{ left: 90, w: 80 }])[0]!.row).toBe(1);
    const crowd = placePinLabels([{ x: 100, label: "Fix 12 PM" }, { x: 104, label: "Fix 1 PM" }, { x: 108, label: "Fix 2 PM" }], w);
    expect(crowd.map((s) => s.row)).toEqual([0, 1, null]);
    // Labels on one line never overlap.
    for (const set of [two, crowd])
      for (const r of [0, 1]) {
        const line = set.filter((s) => s.row === r);
        for (let i = 0; i < line.length; i += 1) for (let j = i + 1; j < line.length; j += 1) expect(overlap(line[i]!, line[j]!)).toBe(false);
      }
    expect(two[0]!.w).toBe(monoWidth("Fix 12 PM"));
  });

  it("keeps a dot per reading, thinned so dots never touch, always the latest and the peak", () => {
    const g = fleetGeometry(incident(), NOW);
    const dots = readingDots(g, incident().series, 300);
    expect(dots[dots.length - 1]!.current).toBe(true);
    expect(dots[dots.length - 1]!.stuck).toBe(9);
    expect(dots.filter((d) => d.peak)).toHaveLength(1);
    expect(dots.find((d) => d.peak)!.stuck).toBe(86);
    // Hourly readings across 48h on a narrow plot: thinned, never closer than the gap.
    const dense = incident({ series: Array.from({ length: 49 }, (_, i) => ({ at: ago(48 - i), stuck: 49 - i })) });
    const gd = fleetGeometry(dense, NOW);
    const thin = readingDots(gd, dense.series, 200);
    expect(thin.length).toBeLessThan(49);
    const xs = thin.map((d) => (d.x / CHART.w) * 200);
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(14 - 0.001);
    expect(thin[thin.length - 1]!.current).toBe(true);
    expect(thin[0]!.peak).toBe(true);
  });

  it("writes the pill as the latest reading, with its age when it is an hour or more old", () => {
    const nowMs = Date.parse(NOW);
    expect(pillText({ at: Date.parse(ago(2)), stuck: 3 }, nowMs)).toBe("3 · 2h ago");
    expect(pillText({ at: nowMs, stuck: 1 }, nowMs)).toBe("1 now");
    expect(pillText({ at: nowMs - 20 * 60_000, stuck: 1.4 }, nowMs)).toBe("1 now");
  });

  it("puts the pill where the line never runs through it", () => {
    const plot = { w: 300, h: 90 };
    const pill = { w: 80, h: 18 };
    const lineY = (line: { x: number; y: number }[], x: number) => {
      for (let i = 1; i < line.length; i += 1) if (x <= line[i]!.x) return line[i - 1]!.y + ((line[i]!.y - line[i - 1]!.y) * (x - line[i - 1]!.x)) / (line[i]!.x - line[i - 1]!.x);
      return line[line.length - 1]!.y;
    };
    const clearOf = (line: { x: number; y: number }[], s: { left: number; top: number }) => {
      for (let x = s.left; x <= s.left + pill.w; x += 1) {
        const y = lineY(line, x);
        if (y > s.top - 1 && y < s.top + pill.h + 1) return false;
      }
      return true;
    };
    // Falling to a low "now": the pill sits above the end of the line, inside the plot.
    const falling = [{ x: 0, y: 10 }, { x: 300, y: 80 }];
    const a = pillSpot(falling, { x: 300, y: 80 }, pill, plot);
    expect(a.side).toBe("above");
    expect(a.left + pill.w).toBeLessThanOrEqual(plot.w);
    expect(clearOf(falling, a)).toBe(true);
    // Rising to the top at "now": no room above, so it goes below.
    const rising = [{ x: 0, y: 80 }, { x: 300, y: 4 }];
    const b = pillSpot(rising, { x: 300, y: 4 }, pill, plot);
    expect(b.side).toBe("below");
    expect(clearOf(rising, b)).toBe(true);
    // A line that crosses the whole height under the pill: up into the strip, with a leader.
    const zig = [{ x: 0, y: 80 }, { x: 225, y: 80 }, { x: 240, y: 2 }, { x: 260, y: 88 }, { x: 300, y: 45 }];
    const c = pillSpot(zig, { x: 300, y: 45 }, pill, plot);
    expect(c.side).toBe("strip");
    expect(c.top).toBeLessThan(0);
    expect(c.leader).toBe(true);
  });
});

describe("BriefFleetRecovery", () => {
  let app: ReturnType<typeof mount> | null = null;
  let target: HTMLElement;
  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });
  function render(card: Partial<Parameters<typeof incident>[0]> & { cols?: number; rows?: number; prompts?: Record<string, string>; reducedMotion?: boolean | null } = {}, host: Record<string, unknown> = {}) {
    const { cols = 2, rows = 2, prompts = {}, reducedMotion = true, ...extra } = card;
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(Harness, { target, props: { card: { incident: incident(extra), prompts, now: NOW, cols, rows, reducedMotion }, ...host } });
    flushSync();
  }
  const q = (sel: string) => target.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...target.querySelectorAll<HTMLElement>(sel)];
  async function hover(el: Element): Promise<void> {
    el.dispatchEvent(new MouseEvent("mouseenter"));
    await new Promise((r) => setTimeout(r, 260));
    flushSync();
  }

  it("leads with the verdict, keeps the eyebrow and the company logo, and shows no total headcount", () => {
    render({}, { companies: [{ uid: "cmp_indigo", label: "Indigo", iconUrl: null }] });
    const root = q('[data-testid="brief-fleet-recovery"]')!;
    expect(root.classList.contains("w")).toBe(true);
    expect(root.getAttribute("data-verdict")).toBe("healing");
    expect(root.getAttribute("data-live")).toBe("true");
    expect(q('[data-testid="brief-fleet-eyebrow"]')!.textContent!.replace(/\s+/g, " ").trim()).toBe("Fleet recovery · 48h");
    expect(q('[data-testid="brief-fleet-verdict"]')!.textContent).toBe("Healing · 9 agents still stuck");
    expect(q('[data-testid="brief-fleet-verdict"]')!.getAttribute("aria-label")).toBe("Healing · 9 agents still stuck");
    // The hero: the still-stuck count, large, with where it came down from and how long it has run.
    expect(q('[data-testid="brief-fleet-count"]')!.textContent).toBe("9");
    expect(q('[data-testid="brief-fleet-meta"]')!.textContent!.replace(/\s+/g, " ").trim()).toBe("down from 86 · open 28h");
    expect(q('[data-testid="brief-origin"]')).not.toBeNull();
    const text = root.textContent!;
    expect(text).not.toMatch(/\bof \d+\b/);
    expect(text).not.toMatch(/\d+ agents? (total|healthy)/i);
    expect(text).not.toContain("95");
    // No repo names or PR numbers on the card.
    expect(text).not.toMatch(/#\d+|indigoai-us/);
  });

  it("caps the stuck set at five dots then a +N more row whose peek lists the rest", async () => {
    render();
    const dots = qa('[data-testid="brief-fleet-agent"]');
    expect(dots).toHaveLength(5);
    expect(dots.map((d) => d.querySelector(".nm")!.textContent)).toEqual(["scout", "atlas", "nimbus", "ember", "orbit"]);
    expect(dots.every((d) => d.querySelector(".dot.breathe"))).toBe(true);
    // Open rows: initial circle, name, phase, and an age pill that turns warm past a day.
    expect(dots.map((d) => d.querySelector(".dot")!.textContent)).toEqual(["S", "A", "N", "E", "O"]);
    expect(dots[0]!.querySelector(".rs")!.textContent).toBe("disk_full");
    expect(dots.map((d) => d.querySelector(".age")!.textContent)).toEqual(["27h", "26h", "25h", "20h", "18h"]);
    expect(dots.map((d) => d.querySelector(".age")!.classList.contains("old"))).toEqual([true, true, true, false, false]);
    const more = q('[data-testid="brief-fleet-more"]')!;
    expect(more.textContent!.replace(/\s+/g, " ").trim()).toBe("+4 more");
    await hover(more);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.textContent).toContain("4 more still stuck");
    expect(qa('[data-testid="brief-peek-line"]').map((l) => `${l.querySelector("div")!.textContent} ${l.querySelector("span")!.textContent}`)).toEqual([
      "pixel disk_full",
      "lumen disk_full",
      "sable setup",
      "quill disk_full",
    ]);
  });

  it("hovering a dot opens a compact card with name, reason, stuck-since and Inspect in Claude", async () => {
    render();
    const scout = qa('[data-testid="brief-fleet-agent"]')[0]!;
    expect(scout.textContent).toContain("27h");
    await hover(scout);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.classList.contains("compact")).toBe(true);
    expect(peek.querySelector(".ttl")!.textContent).toBe("scout");
    expect(peek.querySelector(".st")!.textContent).toBe("disk_full · stuck 27h");
    expect(q('[data-testid="brief-peek-resume"]')!.textContent!.trim()).toBe("Inspect in Claude");
    expect(peek.textContent).not.toContain("Do not change");
  });

  it("Inspect launches the writer's prompt when it has one, else the built-in read-only prompt", async () => {
    const onlaunch = vi.fn(async () => null);
    render({ prompts: { "fi1:scout": "Writer prompt for scout." } }, { onlaunch });
    await hover(qa('[data-testid="brief-fleet-agent"]')[0]!);
    (q('[data-testid="brief-peek-resume"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onlaunch).toHaveBeenCalledWith("claude", "Writer prompt for scout.");
    await hover(qa('[data-testid="brief-fleet-agent"]')[1]!);
    (q('[data-testid="brief-peek-resume"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onlaunch).toHaveBeenLastCalledWith("claude", inspectPrompt(incident().stillStuck[1]!, incident()));
  });

  it("the verdict's peek carries the rule, the peak and the fixes as plain titles", async () => {
    render();
    await hover(q('[data-testid="brief-fleet-verdict"]')!);
    const peek = q('[data-testid="brief-peek"]')!;
    expect(peek.querySelector(".ttl")!.textContent).toBe("Healing");
    expect(peek.textContent).toContain(VERDICT_RULE);
    expect(peek.textContent).toContain("86 stuck at");
    const lines = qa('[data-testid="brief-peek-line"]').map((l) => l.textContent!);
    expect(lines.some((l) => l.includes("Free the disk on setup boxes"))).toBe(true);
    expect(peek.textContent).not.toMatch(/#\d+/);
  });

  it("draws the 48h curve with the incident fill, dashed fix pins with plain labels, and a weekday axis ending in now", () => {
    render({ reducedMotion: false });
    expect(q('[data-testid="brief-fleet-chart"]')).not.toBeNull();
    expect(q('[data-testid="brief-fleet-area"]')).not.toBeNull();
    expect(q('[data-testid="brief-fleet-line"]')!.classList.contains("draw")).toBe(true);
    const pins = qa('[data-testid="brief-fleet-pin"]');
    expect(pins).toHaveLength(2);
    for (const p of pins) expect(p.textContent).toMatch(/^Fix \d{1,2}(:\d{2})? (AM|PM)$/);
    // The pin names the fix in plain words for assistive tech and in its peek, never a PR.
    expect(pins.map((p) => p.getAttribute("aria-label")!.split(",")[0])).toEqual(["Free the disk on setup boxes", "Retry setup after a disk rescue"]);
    const axis = q('[data-testid="brief-fleet-axis"]')!;
    const labels = [...axis.querySelectorAll("span")].map((s) => s.textContent);
    expect(labels[labels.length - 1]).toBe("now");
    expect(labels.slice(0, -1).length).toBeGreaterThanOrEqual(1);
    for (const l of labels.slice(0, -1)) expect(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]).toContain(l);
    // Axis labels never collide: each sits at its own x, apart from the next.
    const boxes = [...axis.querySelectorAll<HTMLElement>("span")].map((s) => ({ left: parseFloat(s.style.left), w: parseFloat(s.style.width) }));
    for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]!.left).toBeGreaterThanOrEqual(boxes[i - 1]!.left + boxes[i - 1]!.w);
  });

  it("marks each reading with a dot, the latest filled and breathing while live, with its value in a pill", () => {
    render();
    expect(qa('[data-testid="brief-fleet-reading"]').length).toBeGreaterThan(0);
    const cur = q('[data-testid="brief-fleet-now"]')!;
    expect(cur.classList.contains("cur")).toBe(true);
    expect(cur.classList.contains("live")).toBe(true);
    expect(q('[data-testid="brief-fleet-pill"]')!.textContent).toBe("9 · 1h ago");
  });

  it("reduced motion turns the draw-in off", () => {
    render({ reducedMotion: true });
    expect(q('[data-testid="brief-fleet-line"]')!.classList.contains("draw")).toBe(false);
  });

  it("at S there is no curve, only the hero and the agents as initial chips; at W the curve returns", () => {
    render({ cols: 1, rows: 1 });
    expect(q('[data-testid="brief-fleet-chart"]')).toBeNull();
    expect(q('[data-testid="brief-fleet-eyebrow"]')!.textContent!.replace(/\s+/g, " ").trim()).toBe("Fleet recovery");
    expect(q('[data-testid="brief-fleet-count"]')!.textContent).toBe("9");
    expect(qa('[data-testid="brief-fleet-agent"]')).toHaveLength(5);
    expect(qa('[data-testid="brief-fleet-agent"]')[0]!.textContent).not.toContain("27h");
    // Five chips: just the initial (the name is in the label and the peek), then "+4 more".
    expect(qa('[data-testid="brief-fleet-agent"]').map((a) => a.textContent!.trim())).toEqual(["S", "A", "N", "E", "O"]);
    expect(qa('[data-testid="brief-fleet-agent"]')[0]!.getAttribute("aria-label")).toBe("scout, disk_full");
    expect(q('[data-testid="brief-fleet-more"]')!.textContent!.replace(/\s+/g, " ").trim()).toBe("+4 more");
    if (app) unmount(app);
    app = null;
    target.remove();
    render({ cols: 2, rows: 1 });
    expect(q('[data-testid="brief-fleet-chart"]')).not.toBeNull();
    if (app) unmount(app);
    app = null;
    target.remove();
    // Two or fewer still stuck: the chips carry the names.
    render({ cols: 1, rows: 1, stillStuck: incident().stillStuck.slice(0, 2) });
    expect(qa('[data-testid="brief-fleet-agent"]').map((a) => a.querySelector(".nm")?.textContent)).toEqual(["scout", "atlas"]);
  });

  it("hides itself once the incident has been closed for more than 24 hours", () => {
    render({ incidentEnd: ago(30) });
    expect(q('[data-testid="brief-fleet-recovery"]')).toBeNull();
    expect(target.textContent!.trim()).toBe("");
  });

  it("a closed incident stops the breathing and the live dot; healed reads as no agent still stuck", () => {
    render({ verdict: "healed", stillStuck: [], incidentEnd: ago(2) });
    const root = q('[data-testid="brief-fleet-recovery"]')!;
    expect(root.getAttribute("data-live")).toBe("false");
    expect(root.querySelector(".live")).toBeNull();
    expect(q('[data-testid="brief-fleet-now"]')!.classList.contains("live")).toBe(false);
    expect(q('[data-testid="brief-fleet-count"]')!.textContent).toBe("0");
    expect(root.querySelector(".dot.breathe")).toBeNull();
    expect(q('[data-testid="brief-fleet-verdict"]')!.textContent).toBe("Healed · no agent still stuck");
    expect(q('[data-testid="brief-fleet-stuck"]')!.textContent).toContain("No agent still stuck.");
    expect(q('[data-testid="brief-fleet-more"]')).toBeNull();
  });

  it("every verdict renders its own title", () => {
    for (const verdict of ["healing", "healed", "plateaued", "relapsing"] as const) {
      render({ verdict, stillStuck: incident().stillStuck.slice(0, 3) });
      expect(q('[data-testid="brief-fleet-verdict"]')!.textContent).toBe(`${verdict[0]!.toUpperCase()}${verdict.slice(1)} · 3 agents still stuck`);
      if (app) unmount(app);
      app = null;
      target.remove();
    }
  });
});
