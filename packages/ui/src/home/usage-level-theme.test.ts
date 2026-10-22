// Company level bar colours (US-019): distinct per level, groups readable,
// limit states win, sheen only at the top levels.

import { describe, expect, it } from "vitest";
import { LEVEL_THEMES, levelHasSheen, levelPaletteActive, levelSegmentColor, levelSegmentVars, levelTheme } from "./usage-level-theme";
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

  it("keeps the three groups apart: distinct colours stepping from deep to light, in light and in dark", () => {
    for (const t of LEVEL_THEMES) {
      for (const parts of [t, t.dark]) {
        expect(new Set([parts.agents, parts.sync, parts.storage]).size).toBe(3);
        const a = avgLightness(parts.agents);
        const s = avgLightness(parts.sync);
        const st = avgLightness(parts.storage);
        expect(a, `level ${t.level}`).toBeLessThan(s);
        expect(s, `level ${t.level}`).toBeLessThan(st);
        // Level 7 also splits the brand gradient by hue, so it needs less lightness spread.
        expect(st - a, `level ${t.level}`).toBeGreaterThan(t.level === 7 ? 0.1 : 0.15);
      }
    }
  });

  it("never uses the limit colours (amber, orange, red) on the bar, in light or dark", () => {
    for (const t of LEVEL_THEMES) {
      for (const h of hexes(`${t.agents} ${t.sync} ${t.storage} ${t.dark.agents} ${t.dark.sync} ${t.dark.storage}`)) {
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

describe("level bar colours are readable on light and dark (WCAG 1.4.11, 3:1)", () => {
  const luminance = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => lin(c / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string): number => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  // The surfaces the bar sits on (Settings and the Core menu), per scheme.
  const SURFACES = { light: ["#ffffff", "#fafafa"], dark: ["#242424", "#2a2a2a"] } as const;

  for (const theme of LEVEL_THEMES) {
    for (const scheme of ["light", "dark"] as const) {
      for (const group of ["agents", "sync", "storage"] as const) {
        it(`level ${theme.level} ${scheme} ${group}: every stop is at least 3:1 on the ${scheme} surfaces`, () => {
          const stops = hexes(scheme === "dark" ? theme.dark[group] : theme[group]);
          expect(stops.length).toBeGreaterThan(0);
          for (const stop of stops) {
            for (const surface of SURFACES[scheme]) expect(contrast(stop, surface), `${stop} on ${surface}`).toBeGreaterThanOrEqual(3);
          }
        });
      }
    }
  }

  it("the bar and the dots carry both palettes, and the dark one is drawn under prefers-color-scheme: dark", () => {
    expect(levelSegmentVars("seg", "agents", 3)).toBe(`--seg:${LEVEL_THEMES[2].agents};--seg-dark:${LEVEL_THEMES[2].dark.agents};`);
    expect(levelSegmentColor("sync", 6, "ok", "dark")).toBe(LEVEL_THEMES[5].dark.sync);
    // A limit state and no level keep the plain group colour in both.
    expect(levelSegmentVars("dot", "agents", 3, "near")).toBe(`--dot:${segmentColor("agents")};--dot-dark:${segmentColor("agents")};`);
  });
});
