import { describe, expect, it } from "vitest";
import {
  DAWN_BOB,
  WELCOME_HORIZON_Y,
  WELCOME_SEA_BOTTOM,
  WELCOME_SUN_R,
  bloomAt,
  dawnDisplay,
  dawnLook,
  easeDawn,
  welcomeElevation,
  welcomeSky,
  welcomeSunRow,
  welcomeSunX,
} from "./brief-dawn.js";

describe("sunrise easing", () => {
  it("eases toward the real progress without jumping, and never passes it", () => {
    let shown = 0;
    let time = 0;
    const seen: number[] = [];
    for (let i = 0; i < 600; i += 1) {
      time += 1 / 60;
      shown = easeDawn(shown, 0.5, 1 / 60, time, false);
      const drawn = dawnDisplay(shown, 0.5, time, false);
      seen.push(drawn);
      expect(drawn).toBeLessThanOrEqual(0.5);
    }
    for (let i = 1; i < 60; i += 1) expect(Math.abs(seen[i]! - seen[i - 1]!)).toBeLessThan(0.05);
    expect(seen.at(-1)!).toBeGreaterThan(0.5 - DAWN_BOB - 0.001);
  });

  it("keeps moving between polls (idle bob) while a step runs long", () => {
    let shown = 0.5;
    const values = new Set<string>();
    for (let t = 0; t < 4; t += 0.25) {
      shown = easeDawn(shown, 0.5, 0.25, t, false);
      values.add(dawnDisplay(shown, 0.5, t, false).toFixed(4));
    }
    expect(values.size).toBeGreaterThan(3);
  });

  it("reduced motion shows the real progress as a static frame", () => {
    expect(easeDawn(0, 0.7, 0.016, 3, true)).toBe(0.7);
    expect(dawnDisplay(0.7, 0.7, 3, true)).toBe(0.7);
  });

  it("derives stars, warmth and color from elevation; failed drains color", () => {
    expect(dawnLook(0, 0)).toMatchObject({ elevation: 0, stars: 1, warmth: 0, desaturate: 0 });
    expect(dawnLook(1, 0)).toMatchObject({ elevation: 1, stars: 0, warmth: 1 });
    const failed = dawnLook(0.5, 1);
    expect(failed.desaturate).toBe(1);
    expect(failed.warmth).toBeLessThan(dawnLook(0.5, 0).warmth);
  });

  it("the ready bloom rises then falls within 900 ms", () => {
    expect(bloomAt(0)).toBe(0);
    expect(bloomAt(180)).toBe(1);
    expect(bloomAt(540)).toBeCloseTo(0.5);
    expect(bloomAt(900)).toBe(0);
  });
});

describe("welcome layout geometry", () => {
  it("puts the sun at about 73% of the pane, snapped to the 8 px grid", () => {
    expect(welcomeSunX(1244)).toBe(912);
    expect(welcomeSunX(1244) % 8).toBe(0);
    // Narrow panes keep the sun clear of the headline column.
    expect(welcomeSunX(400)).toBe(600);
    expect(welcomeSunX(Number.NaN)).toBe(600);
  });

  it("starts the sun half under the horizon and lifts it above as the rise ends", () => {
    const hz = WELCOME_HORIZON_Y / 8;
    expect(welcomeSunRow(hz, 0)).toBeCloseTo(hz + WELCOME_SUN_R * 0.47);
    expect(welcomeSunRow(hz, 1)).toBeCloseTo(hz - WELCOME_SUN_R * 1.2);
    expect(welcomeSunRow(hz, 2)).toBe(welcomeSunRow(hz, 1));
    // eased like round 11b: half the elevation already lifts the sun past half its climb
    const half = welcomeSunRow(hz, 0.5);
    expect(welcomeSunRow(hz, 0) - half).toBeGreaterThan((welcomeSunRow(hz, 0) - welcomeSunRow(hz, 1)) / 2);
  });

  it("keeps the welcome sun on the horizon while sources are read", () => {
    expect(welcomeElevation(0)).toBe(0);
    expect(welcomeElevation(0.3)).toBe(0);
    expect(welcomeElevation(0.62)).toBe(0);
    expect(welcomeElevation(1)).toBe(1);
    expect(welcomeElevation(0.81)).toBeGreaterThan(0.4);
    expect(welcomeElevation(Number.NaN)).toBe(0);
    expect(WELCOME_SEA_BOTTOM).toBeGreaterThan(WELCOME_HORIZON_Y);
  });

  it("lights the sky toward cream in light theme and toward night ink in dark", () => {
    expect(welcomeSky("light", 0)[0]).toEqual([251, 235, 216]);
    expect(welcomeSky("light", 1)[0]).toEqual([255, 247, 231]);
    expect(welcomeSky("dark", 1)[0]).toEqual([20, 18, 25]);
  });
});
