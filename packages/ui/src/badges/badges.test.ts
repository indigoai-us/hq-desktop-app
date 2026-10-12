import { afterEach, describe, expect, it } from "vitest";
import { BADGES, BADGE_BY_ID, MICRO_ICONS, SMALL_ICONS, resolveEarned, type BadgeTier } from "./badge-catalog.js";
import { badgesFor, setBadgeSource } from "./badge-source.js";
import { badgeMarkPx } from "./badge-mark.js";
import { badgeTheme, inkForLight } from "./badge-theme.js";

afterEach(() => setBadgeSource(null));

describe("badge catalog", () => {
  it("has 19 badges with unique ids and art for both sizes", () => {
    expect(BADGES).toHaveLength(19);
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(19);
    for (const b of BADGES) {
      expect(SMALL_ICONS[b.icon]?.art.length).toBeGreaterThan(0);
      expect(MICRO_ICONS[b.icon]?.art.length).toBeGreaterThan(0);
    }
  });

  it("resolves earned badges newest first, keeps the earned tier and drops unknown ids", () => {
    const out = resolveEarned([
      { id: "liftoff", tier: 2, earnedAt: "2026-09-01" },
      { id: "nope", earnedAt: "2026-10-09" },
      { id: "founding", earnedAt: "2026-10-01" },
    ]);
    expect(out.map((e) => e.def.id)).toEqual(["founding", "liftoff"]);
    expect(out[0].tier).toBe(BADGE_BY_ID.founding.tier);
    expect(out[1].tier).toBe(2);
  });

  it("sizes marks at 54px (micro) and 108px (small)", () => {
    expect(badgeMarkPx("micro")).toBe(54);
    expect(badgeMarkPx("small")).toBe(108);
  });
});

describe("badge source", () => {
  it("returns no badges until a source is installed", () => {
    expect(badgesFor({ kind: "person", name: "Ada" })).toEqual([]);
  });

  it("uses the installed source, and is empty for a blank name or a failing source", () => {
    setBadgeSource(() => [{ id: "founder", earnedAt: "2026-03-04" }]);
    expect(badgesFor({ kind: "person", name: "Ada" })).toHaveLength(1);
    expect(badgesFor({ kind: "person", name: "  " })).toEqual([]);
    setBadgeSource(() => {
      throw new Error("offline");
    });
    expect(badgesFor({ kind: "bot", name: "deacon" })).toEqual([]);
  });
});

describe("badge levels", async () => {
  const { badgeLevels } = await import("./badge-levels.js");
  it("marks the reached level and carries the unit to bare numbers", () => {
    const rows = badgeLevels(BADGE_BY_ID.liftoff, 2);
    expect(rows.map((r) => r.label)).toEqual(["5 deploys", "50 deploys", "250 deploys"]);
    expect(rows.map((r) => [r.reached, r.current])).toEqual([[true, false], [true, true], [false, false]]);
  });
  it("gives single-level and limited badges one row", () => {
    expect(badgeLevels(BADGE_BY_ID.founding, BADGE_BY_ID.founding.tier)).toEqual([
      { tier: "Gold", label: "Limited, never earnable again", reached: true, current: true },
    ]);
  });
  it("uses the singular for a first level of one", () => {
    expect(badgeLevels(BADGE_BY_ID.fleet, 1).map((r) => r.label)).toEqual(["1 agent", "5 agents", "15 agents"]);
  });
  it("gives a four-level badge a Legendary top level", () => {
    const rows = badgeLevels(BADGE_BY_ID.corebuilder, "L");
    expect(rows.map((r) => [r.tier, r.label])).toEqual([
      ["Bronze", "1 PR"],
      ["Silver", "10 PRs"],
      ["Gold", "100 PRs"],
      ["Legendary", "200 PRs"],
    ]);
    expect(rows.map((r) => [r.reached, r.current])).toEqual([[true, false], [true, false], [true, false], [true, true]]);
    expect(badgeLevels(BADGE_BY_ID.corebuilder, 3).map((r) => [r.reached, r.current])).toEqual([[true, false], [true, false], [true, true], [false, false]]);
  });
  it("keeps three-level badges at three rows, with Gold as the top", () => {
    const rows = badgeLevels(BADGE_BY_ID.liftoff, "L");
    expect(rows.map((r) => r.tier)).toEqual(["Bronze", "Silver", "Gold"]);
    expect(rows.map((r) => r.current)).toEqual([false, false, true]);
  });
  it("gives the honors badges one Legendary row", () => {
    for (const id of ["og", "captain", "patientzero"]) {
      expect(badgeLevels(BADGE_BY_ID[id], BADGE_BY_ID[id].tier)).toEqual([{ tier: "Legendary", label: "Single level", reached: true, current: true }]);
    }
  });
});

/**
 * Owner feedback (2026-10-08): "a lot of the badges in light mode looks faint"
 * → the app draws light mode with its own, deeper palette.
 */
describe("light-mode badges", () => {
  it("follows the forced theme, then the system setting", () => {
    const rootWith = (theme: string) => ({ getAttribute: () => theme }) as unknown as HTMLElement;
    expect(badgeTheme(rootWith("light"))).toBe("light");
    expect(badgeTheme(rootWith("dark"))).toBe("dark");
  });

  it("deepens pastel inks so they read on a light surface", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      return 0.3 * r + 0.59 * g + 0.11 * b;
    };
    for (const pastel of ["#8fd6a0", "#ffd27a", "#c3c9dd"]) {
      expect(lum(inkForLight(pastel))).toBeLessThan(lum(pastel) - 0.2);
    }
  });

  it("has full-size art for every level of the new badges", async () => {
    const { FULL_ASCII } = await import("./full-ascii-data.js");
    for (const key of ["og:L", "captain:L", "patientzero:L", "corebuilder:1", "corebuilder:2", "corebuilder:3", "corebuilder:L"]) {
      const art = FULL_ASCII[key];
      expect(art, key).toBeDefined();
      expect(art.chars).toHaveLength(24);
      expect(art.colors).toHaveLength(24);
      for (const row of art.chars) expect(row).toHaveLength(48);
    }
  });

  it("has full-size art for every tier each badge can be earned at", async () => {
    const { FULL_ASCII } = await import("./full-ascii-data.js");
    for (const def of BADGES) {
      const levels = def.levels.split(" · ").length;
      const tiers: BadgeTier[] = levels >= 4 ? [1, 2, 3, "L"] : levels === 3 ? [1, 2, 3] : [def.tier];
      for (const tier of tiers) expect(FULL_ASCII[`${def.id}:${tier}`], `${def.id}:${tier}`).toBeDefined();
    }
  });

  it("has light colours for every full-size badge, on the same character grid", async () => {
    const [{ FULL_ASCII }, { FULL_ASCII_LIGHT }] = await Promise.all([
      import("./full-ascii-data.js"),
      import("./full-ascii-data-light.js"),
    ]);
    expect(Object.keys(FULL_ASCII_LIGHT).sort()).toEqual(Object.keys(FULL_ASCII).sort());
    for (const [id, art] of Object.entries(FULL_ASCII)) {
      const light = FULL_ASCII_LIGHT[id];
      expect(light.colors).toHaveLength(art.colors.length);
      light.colors.forEach((row, y) => {
        // An ink wherever the dark art has one, and nowhere else.
        expect([...row].map((c) => c === ".").join()).toBe([...art.colors[y]].map((c) => c === ".").join());
      });
    }
  });
});

/**
 * Owner request (2026-10-12): Founding Member moved from Legendary to Gold,
 * but its full-size art kept the Legendary ring in the HQ gradient. Every
 * badge at a tier wears the same frame, so Founding Member's must be the
 * gold one, in dark and in light.
 */
describe("full-size frames", async () => {
  const [{ FULL_ASCII, PALETTE_ALPHABET }, { FULL_ASCII_LIGHT }] = await Promise.all([
    import("./full-ascii-data.js"),
    import("./full-ascii-data-light.js"),
  ]);
  type Cell = [number, number];
  const ink = (palette: readonly string[], colors: readonly string[], [y, x]: Cell) => {
    const ch = colors[y][x];
    return ch === "." ? null : palette[PALETTE_ALPHABET.indexOf(ch)];
  };
  const dark = (key: string, cell: Cell) => ink(FULL_ASCII[key].palette, FULL_ASCII[key].colors, cell);
  const light = (key: string, cell: Cell) => ink(FULL_ASCII_LIGHT[key].palette, FULL_ASCII_LIGHT[key].colors, cell);
  const glyph = (key: string, [y, x]: Cell) => FULL_ASCII[key].chars[y][x];
  const keys = Object.keys(FULL_ASCII);
  const tierOf = (key: string) => key.split(":")[1];
  const hsl = (entry: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(entry.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return { h: 0, s: 0 };
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h * 60, s };
  };
  /**
   * The frame: the cells the Legendary badges all draw the same, leaving out
   * the grey sparkles scattered inside, which an icon may cover.
   */
  const legendary = keys.filter((k) => tierOf(k) === "L");
  const frame: Cell[] = [];
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 48; x++) {
      const [ref, ...rest] = legendary;
      const own = dark(ref, [y, x]);
      if (!own || hsl(own).s <= 0.25) continue;
      if (rest.every((k) => glyph(k, [y, x]) === glyph(ref, [y, x]) && dark(k, [y, x]) === own && light(k, [y, x]) === light(ref, [y, x]))) frame.push([y, x]);
    }
  }

  it("finds the ring all the way round", () => {
    expect(frame.length).toBeGreaterThan(200);
  });

  it("gives every badge at a tier the same frame, glyph for glyph, in dark and light", () => {
    for (const tier of ["1", "2", "3", "L"]) {
      const [ref, ...rest] = keys.filter((k) => tierOf(k) === tier);
      for (const key of rest) {
        for (const cell of frame) {
          expect([glyph(key, cell), dark(key, cell), light(key, cell)], `${key} at ${cell}`).toEqual([glyph(ref, cell), dark(ref, cell), light(ref, cell)]);
        }
      }
    }
  });

  it("draws Founding Member in the gold ring, not the Legendary HQ gradient", () => {
    expect(BADGE_BY_ID.founding.tier).toBe(3);
    const gold = keys.filter((k) => tierOf(k) === "3" && k !== "founding:3");
    for (const cell of frame) {
      for (const read of [dark, light]) {
        const own = read("founding:3", cell)!;
        // The same ink every other Gold badge has here.
        expect(gold.every((k) => read(k, cell) === own), `founding:3 at ${cell}: ${own}`).toBe(true);
        // Coloured ring inks are gold, amber or orange: no indigo, violet or pink from the HQ gradient.
        const { h, s } = hsl(own);
        if (s > 0.25) expect(h, `founding:3 at ${cell}: ${own}`).toBeGreaterThanOrEqual(20);
        if (s > 0.25) expect(h, `founding:3 at ${cell}: ${own}`).toBeLessThanOrEqual(60);
      }
    }
  });
});
