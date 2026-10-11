import { afterEach, describe, expect, it } from "vitest";
import { BADGES, BADGE_BY_ID, MICRO_ICONS, SMALL_ICONS, resolveEarned } from "./badge-catalog.js";
import { badgesFor, setBadgeSource } from "./badge-source.js";
import { badgeMarkPx } from "./badge-mark.js";
import { badgeTheme, inkForLight } from "./badge-theme.js";

afterEach(() => setBadgeSource(null));

describe("badge catalog", () => {
  it("has 15 badges with unique ids and art for both sizes", () => {
    expect(BADGES).toHaveLength(15);
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(15);
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
