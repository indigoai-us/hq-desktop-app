import { describe, expect, it } from "vitest";
import {
  RISE_CRUMB,
  RISE_EYEBROW,
  RISE_HALO_ALPHA_DARK,
  RISE_HALO_ALPHA_LIGHT,
  RISE_HEADLINE,
  RISE_ICON,
  RISE_PITCH,
  RISE_READING,
  RISE_SPEED,
  RISE_SUB,
  riseCompaniesLine,
  riseDateLine,
  riseDawnProgress,
  riseElapsedText,
  riseFrame,
  riseHaloCells,
  riseRevealAt,
  riseRippleCells,
  riseStepLine,
  welcomeRiseSources,
  type RiseSource,
} from "./brief-rise.js";

const SOURCES: RiseSource[] = [
  { id: "claude", label: "Claude", counts: { sessions: 168 }, finding: "168 sessions in Claude Code" },
  { id: "codex", label: "Codex", counts: { sessions: 244, repos: 3 }, finding: "244 sessions across 3 repos" },
  { id: "calendar", label: "Calendar", counts: { calendars: 1 }, finding: "1 calendar" },
  { id: "repos", label: "Repos", counts: { repos: 3 }, finding: "3 more repos" },
];

describe("rise horizon crossing", () => {
  it("updates the count and the card on the frame each source's centre crosses the horizon", () => {
    SOURCES.forEach((source, index) => {
      const at = riseRevealAt(index);
      const before = riseFrame(at - 0.001, SOURCES);
      const frame = riseFrame(at, SOURCES);
      expect(before.cards.map((card) => card.id)).not.toContain(source.id);
      expect(frame.cards.map((card) => card.id)).toContain(source.id);
      expect(frame.cards.find((card) => card.id === source.id)?.text).toBe(source.finding);
      const icon = frame.icons[index]!;
      expect(Math.abs(icon.centerY)).toBeLessThan(1);
      expect(icon.visible).toBe(true);
      expect(icon.crossesSun).toBe(false);
      if (index === 0) expect(frame.countText).toBe("168 sessions read");
      if (index === 1) expect(frame.countText).toBe("412 sessions read · 3 repos");
      if (index === 2) expect(frame.countText).toBe("412 sessions read · 3 repos · 1 calendar");
      if (index === 3) expect(frame.countText).toBe("412 sessions read · 6 repos · 1 calendar");
      expect(before.countText).not.toBe(frame.countText);
    });
  });

  it("does not draw an icon that is still fully underwater, and never a reflection", () => {
    const early = riseFrame(1, SOURCES);
    expect(early.icons.every((icon) => icon.visible === false)).toBe(true);
    expect(early.cards).toEqual([]);
    const emerging = riseRevealAt(0) - RISE_ICON / 2 / RISE_SPEED;
    const frame = riseFrame(emerging + 0.05, SOURCES);
    const icon = frame.icons[0]!;
    expect(icon.visible).toBe(true);
    expect(icon.centerY).toBeGreaterThan(0);
    expect(icon.ripple).toBe(true);
    expect(frame.cards).toEqual([]);
  });

  it("keeps every icon clear of the sun while it is on screen", () => {
    for (let t = 0; t <= 24; t += 0.05) {
      const frame = riseFrame(t, SOURCES);
      for (const icon of frame.icons) {
        if (!icon.visible) continue;
        expect(icon.crossesSun).toBe(false);
        expect(Math.abs(icon.lane)).toBeGreaterThan(RISE_ICON);
      }
    }
  });
});

describe("rise reduced motion", () => {
  it("fades the icon in place at the horizon and updates the count and card together", () => {
    const at = riseRevealAt(1);
    const before = riseFrame(at - 0.001, SOURCES, { reducedMotion: true });
    const frame = riseFrame(at, SOURCES, { reducedMotion: true });
    expect(before.icons.every((icon) => icon.visible === false)).toBe(true);
    expect(before.cards.map((card) => card.id)).not.toContain("codex");
    const icon = frame.icons[1]!;
    expect(icon.centerY).toBe(-(RISE_ICON / 2 + RISE_PITCH));
    expect(icon.whole).toBe(true);
    expect(icon.visible).toBe(true);
    expect(icon.ripple).toBe(false);
    expect(frame.cards.map((card) => card.id)).toEqual(["claude", "codex"]);
    expect(frame.countText).toBe("412 sessions read · 3 repos");
  });
});

describe("rise failed source", () => {
  it("shows one calm line and does not add that source to the count", () => {
    const sources: RiseSource[] = [
      SOURCES[0]!,
      SOURCES[1]!,
      { id: "calendar", label: "Calendar", counts: { calendars: 1 }, finding: "1 calendar", failed: true, failureLine: "Calendar could not be read." },
    ];
    const frame = riseFrame(riseRevealAt(2), sources);
    const card = frame.cards.find((row) => row.id === "calendar");
    expect(card).toEqual({ id: "calendar", label: "Calendar", text: "Calendar could not be read.", detail: "", failed: true });
    expect(frame.countText).toBe("412 sessions read · 3 repos");
    expect(frame.countText).not.toContain("calendar");
  });
});

describe("rise companies", () => {
  it("zero companies is a getting-started brief, not a company gate", () => {
    const companies: { id: string; name: string }[] = [];
    const frame = riseFrame(riseRevealAt(1), welcomeRiseSources(companies), { companies });
    expect(riseCompaniesLine(companies)).toBe("Your brief starts here, before you join a company.");
    expect(frame.companyGate).toBe(false);
    expect(frame.companiesLine).not.toContain("Open a company first");
    expect(frame.cards.map((card) => card.id)).toEqual(["sessions", "start"]);
  });

  it("three companies each cross the horizon and stay in one brief", () => {
    const companies = [
      { id: "northwind", name: "Northwind" },
      { id: "acme", name: "Acme" },
      { id: "initech", name: "Initech" },
    ];
    const sources = welcomeRiseSources(companies);
    const frame = riseFrame(riseRevealAt(3), sources, { companies });
    expect(frame.cards.map((card) => card.id)).toEqual(["sessions", "northwind", "acme", "initech"]);
    expect(frame.countText).toBe("4 sessions read");
    expect(frame.companiesLine).toBe("Northwind · Acme · Initech");
    expect(frame.companyGate).toBe(false);
  });
});

describe("rise pixels", () => {
  it("draws a halo of 6 px cells on an 8 px pitch in both themes", () => {
    for (const theme of ["dark", "light"] as const) {
      const cells = riseHaloCells(theme);
      expect(cells.length).toBeGreaterThan(12);
      for (const cell of cells) {
        expect(Math.abs(cell.x % RISE_PITCH)).toBe(0);
        expect(Math.abs(cell.y % RISE_PITCH)).toBe(0);
      }
    }
    expect(riseHaloCells("light").some((cell) => cell.color === "#d67860")).toBe(true);
    expect(riseHaloCells("dark").some((cell) => cell.color === "#ffb580")).toBe(true);
  });

  it("fades the halo with distance from the mark, softer in dark than full strength", () => {
    for (const [theme, peak] of [["dark", RISE_HALO_ALPHA_DARK], ["light", RISE_HALO_ALPHA_LIGHT]] as const) {
      const cells = riseHaloCells(theme).map((cell) => ({ d: Math.hypot(cell.x + 3, cell.y + 3), alpha: cell.alpha }));
      expect(Math.max(...cells.map((cell) => cell.alpha))).toBeLessThanOrEqual(peak);
      expect(Math.min(...cells.map((cell) => cell.alpha))).toBeGreaterThanOrEqual(0);
      const inner = cells.filter((cell) => cell.d < RISE_ICON / 2);
      const outer = cells.filter((cell) => cell.d > RISE_ICON / 2 + 20);
      expect(inner.length).toBeGreaterThan(0);
      expect(outer.length).toBeGreaterThan(0);
      expect(Math.max(...inner.map((cell) => cell.alpha))).toBeGreaterThanOrEqual(peak * 0.8);
      expect(Math.min(...inner.map((cell) => cell.alpha))).toBeGreaterThan(Math.max(...outer.map((cell) => cell.alpha)));
      expect(Math.max(...outer.map((cell) => cell.alpha))).toBeLessThan(peak * 0.25);
    }
    expect(RISE_HALO_ALPHA_DARK).toBeLessThan(0.7);
  });

  it("keeps a short ripple at emergence and none outside that window", () => {
    expect(riseRippleCells(0.2, "dark").length).toBeGreaterThan(0);
    expect(riseRippleCells(0.2, "light").length).toBeGreaterThan(0);
    expect(riseRippleCells(0.2, "dark").every((cell) => cell.alpha === 1 && cell.color.startsWith("rgba("))).toBe(true);
    expect(riseRippleCells(-0.01, "dark")).toEqual([]);
    expect(riseRippleCells(0.61, "dark")).toEqual([]);
    // Gate review: the ring is one joined shape (sides meet the bottom arc), never a bracket of
    // lone side cells plus a separate dash. Cells touch when they are one pitch apart, diagonals too.
    for (let age = 0; age <= 0.6; age += 0.05) {
      const cells = riseRippleCells(age, "dark");
      const key = (x: number, y: number) => x + "," + y;
      const all = new Set(cells.map((c) => key(c.x, c.y)));
      const seen = new Set<string>();
      const stack = [cells[0]!];
      while (stack.length) {
        const c = stack.pop()!;
        if (seen.has(key(c.x, c.y))) continue;
        seen.add(key(c.x, c.y));
        for (const dx of [-RISE_PITCH, 0, RISE_PITCH]) {
          for (const dy of [-RISE_PITCH, 0, RISE_PITCH]) {
            if (all.has(key(c.x + dx, c.y + dy))) stack.push({ ...c, x: c.x + dx, y: c.y + dy });
          }
        }
      }
      expect(seen.size, "age " + age.toFixed(2)).toBe(all.size);
      // It starts at the waterline and dips below it, wider than the mark.
      const ys = cells.map((c) => c.y);
      expect(Math.min(...ys)).toBe(0);
      expect(Math.max(...ys)).toBeGreaterThan(0);
      const xs = cells.map((c) => c.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(RISE_ICON - RISE_PITCH);
    }
    const cleared = riseFrame(riseRevealAt(0) + RISE_ICON / 2 / RISE_SPEED + 0.02, SOURCES);
    const icon = cleared.icons[0]!;
    expect(icon.whole).toBe(true);
    expect(icon.centerY + RISE_ICON / 2).toBeLessThanOrEqual(0);
    expect(icon.ripple).toBe(true);
  });
});

describe("rise handoff", () => {
  it("is still the sunrise after two minutes when the brief is not ready", () => {
    const frame = riseFrame(120, SOURCES, { readyAt: null });
    expect(frame.building).toBe(true);
    expect(frame.briefOpacity).toBe(0);
    expect(riseDawnProgress(120, null)).toBeGreaterThan(0.5);
    expect(riseDawnProgress(120, null)).toBeLessThan(1);
  });

  it("cross-fades into the brief instead of cutting", () => {
    const readyAt = 30;
    expect(riseFrame(readyAt, SOURCES, { readyAt }).briefOpacity).toBe(0);
    const mid = riseFrame(readyAt + 0.3, SOURCES, { readyAt });
    expect(mid.briefOpacity).toBeGreaterThan(0.4);
    expect(mid.briefOpacity).toBeLessThan(0.6);
    expect(riseFrame(readyAt + 0.6, SOURCES, { readyAt }).briefOpacity).toBe(1);
  });
});

describe("welcome rise page copy", () => {
  it("dates the page header the way the mockup does", () => {
    expect(riseDateLine(new Date(2026, 9, 17, 9))).toBe("Saturday, October 17");
  });

  it("counts elapsed time in seconds, then minutes", () => {
    expect(riseElapsedText(0)).toBe("0 sec elapsed");
    expect(riseElapsedText(17.6)).toBe("17 sec elapsed");
    expect(riseElapsedText(125)).toBe("2 min elapsed");
  });

  it("names the source being read, latest revealed first", () => {
    const sources: RiseSource[] = [
      { id: "claude", label: "Claude Code", icon: "claude", counts: { sessions: 168 }, finding: "" },
      { id: "repos", label: "Repos", icon: "repos", counts: { repos: 3 }, finding: "" },
    ];
    expect(riseStepLine(0, [])).toBe(RISE_READING);
    expect(riseStepLine(0, sources)).toBe("Reading your Claude Code sessions");
    expect(riseStepLine(riseRevealAt(1) + 0.1, sources)).toBe("Reading your repos");
    expect(riseStepLine(0, [{ id: "s", label: "Sessions", icon: "claude", counts: {}, finding: "" }])).toBe("Reading your sessions");
    expect(riseStepLine(0, [{ id: "s", label: "Start", icon: "start", counts: {}, finding: "" }])).toBe("Getting your brief started");
    expect(riseStepLine(0, [{ id: "n", label: "Northstar", icon: "company", counts: {}, finding: "" }])).toBe("Reading Northstar");
  });

  it("keeps the page copy in sentence case with no exclamation marks or em dashes", () => {
    for (const line of [RISE_CRUMB, RISE_EYEBROW, RISE_HEADLINE, RISE_SUB, RISE_READING]) {
      expect(line).not.toMatch(/[!—]/);
    }
    expect(RISE_HEADLINE).toBe("Your day is coming into focus.");
  });
});
