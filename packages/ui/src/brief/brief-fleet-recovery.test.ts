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
  inspectPrompt,
  peakOf,
  stuckFor,
  stuckList,
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

  it("draws the 48h curve with the red area, dashed fix pins with plain labels, and a weekday axis ending in now", () => {
    render({ reducedMotion: false });
    expect(q('[data-testid="brief-fleet-chart"]')).not.toBeNull();
    expect(q('[data-testid="brief-fleet-area"]')).not.toBeNull();
    expect(q('[data-testid="brief-fleet-line"]')!.classList.contains("draw")).toBe(true);
    const pins = qa('[data-testid="brief-fleet-pin"]');
    expect(pins).toHaveLength(2);
    for (const p of pins) expect(p.textContent).toMatch(/^Fix landed \d{1,2}(:\d{2})? (AM|PM)$/);
    const axis = q('[data-testid="brief-fleet-axis"]')!;
    const labels = [...axis.querySelectorAll("span")].map((s) => s.textContent);
    expect(labels[labels.length - 1]).toBe("now");
    expect(labels.slice(0, -1).length).toBeGreaterThanOrEqual(1);
    for (const l of labels.slice(0, -1)) expect(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]).toContain(l);
  });

  it("reduced motion turns the draw-in off", () => {
    render({ reducedMotion: true });
    expect(q('[data-testid="brief-fleet-line"]')!.classList.contains("draw")).toBe(false);
  });

  it("at S there is no curve, only the verdict and the dots; at W the curve returns", () => {
    render({ cols: 1, rows: 1 });
    expect(q('[data-testid="brief-fleet-chart"]')).toBeNull();
    expect(q('[data-testid="brief-fleet-eyebrow"]')!.textContent!.replace(/\s+/g, " ").trim()).toBe("Fleet recovery");
    expect(qa('[data-testid="brief-fleet-agent"]')).toHaveLength(5);
    expect(qa('[data-testid="brief-fleet-agent"]')[0]!.textContent).not.toContain("27h");
    if (app) unmount(app);
    app = null;
    target.remove();
    render({ cols: 2, rows: 1 });
    expect(q('[data-testid="brief-fleet-chart"]')).not.toBeNull();
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
