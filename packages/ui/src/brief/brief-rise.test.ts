import { describe, expect, it } from "vitest";
import {
  RISE_ICON,
  RISE_PITCH,
  RISE_SPEED,
  riseCompaniesLine,
  riseDawnProgress,
  riseFrame,
  riseHaloCells,
  riseRevealAt,
  riseRippleCells,
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

  it("keeps a short ripple at emergence and none outside that window", () => {
    expect(riseRippleCells(0.2, "dark").length).toBeGreaterThan(0);
    expect(riseRippleCells(0.2, "light").length).toBeGreaterThan(0);
    expect(riseRippleCells(-0.01, "dark")).toEqual([]);
    expect(riseRippleCells(0.61, "dark")).toEqual([]);
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
