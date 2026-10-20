// Company level bar colours (US-019): distinct per level, groups readable,
// limit states win, sheen only at the top levels.

import { describe, expect, it } from "vitest";
import { LEVEL_THEMES, levelHasSheen, levelPaletteActive, levelSegmentColor, levelTheme } from "./usage-level-theme";
import { segmentColor } from "./usage-stack";

const HEX = /#[0-9a-f]{6}/gi;

function hexes(css: string): string[] {
  return (css.match(HEX) ?? []).map((h) => h.toLowerCase());
}

/** Hue (0..360) and lightness (0..1) of a #rrggbb colour. */
function hsl(hex: string): { h: number; l: number; s: number } {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, l, s: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, l, s };
}

function avgLightness(css: string): number {
  const hs = hexes(css);
  return hs.reduce((sum, h) => sum + hsl(h).l, 0) / hs.length;
}

describe("level themes", () => {
  it("has a theme for each of the seven levels and none for level 0", () => {
    expect(LEVEL_THEMES.map((t) => t.level)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(levelTheme(0)).toBeNull();
    expect(levelTheme(8)).toBeNull();
  });

  it("gives every level its own palette", () => {
    const keys = LEVEL_THEMES.map((t) => `${t.agents}|${t.sync}|${t.storage}`);
    expect(new Set(keys).size).toBe(7);
  });

  it("gets more special as levels rise: flat, then gradient, then sheen", () => {
    expect(LEVEL_THEMES.map((t) => t.finish)).toEqual(["flat", "flat", "flat", "flat", "gradient", "sheen", "sheen"]);
  });

  it("keeps the three groups apart: distinct colours stepping from deep to light", () => {
    for (const t of LEVEL_THEMES) {
      expect(new Set([t.agents, t.sync, t.storage]).size).toBe(3);
      const a = avgLightness(t.agents);
      const s = avgLightness(t.sync);
      const st = avgLightness(t.storage);
      // Level 7 splits the brand gradient by hue instead; every other level steps lightness.
      if (t.level !== 7) {
        expect(a).toBeLessThan(s);
        expect(s).toBeLessThan(st);
        expect(st - a).toBeGreaterThan(0.15);
      }
    }
  });

  it("never uses the limit colours (amber, orange, red) at levels 1 to 6", () => {
    for (const t of LEVEL_THEMES.filter((x) => x.level <= 6)) {
      for (const h of hexes(`${t.agents} ${t.sync} ${t.storage}`)) {
        const { h: hue, s } = hsl(h);
        if (s < 0.2) continue;
        expect(hue < 15 || hue > 55, `${h} at level ${t.level}`).toBe(true);
      }
    }
  });
});

describe("levelSegmentColor", () => {
  it("is the plain group colour with no level", () => {
    for (const id of ["agents", "sync", "storage", "other"]) expect(levelSegmentColor(id, 0)).toBe(segmentColor(id));
  });

  it("is the level colour when calm", () => {
    const t = levelTheme(3)!;
    expect(levelSegmentColor("agents", 3)).toBe(t.agents);
    expect(levelSegmentColor("sync", 3)).toBe(t.sync);
    expect(levelSegmentColor("storage", 3)).toBe(t.storage);
    expect(levelSegmentColor("other", 3)).toBe(t.storage);
  });

  it("drops back to the plain group colours near or at a limit", () => {
    for (const tone of ["near", "at"] as const) {
      expect(levelSegmentColor("agents", 7, tone)).toBe(segmentColor("agents"));
      expect(levelPaletteActive(7, tone)).toBe(false);
      expect(levelHasSheen(7, tone)).toBe(false);
    }
  });

  it("leaves the trial total in its neutral ink", () => {
    expect(levelSegmentColor("trial", 6)).toBe(segmentColor("trial"));
  });

  it("allows the sheen only at levels 6 and 7", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => levelHasSheen(n, "ok"))).toEqual([false, false, false, false, false, false, true, true]);
  });
});
