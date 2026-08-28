import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOW_TRANSPARENCY,
  normalizeColorTheme,
  normalizeWindowTransparency,
  windowOpacityFromTransparency,
  windowTransparencyFromOpacity,
} from "./appearance-seam";

describe("appearance value contracts (desktop appearancePreferences port)", () => {
  it("normalizes color themes to the system default", () => {
    expect(normalizeColorTheme("light")).toBe("light");
    expect(normalizeColorTheme("dark")).toBe("dark");
    expect(normalizeColorTheme("mauve")).toBe("system");
    expect(normalizeColorTheme(undefined)).toBe("system");
  });

  it("clamps and rounds window transparency", () => {
    expect(normalizeWindowTransparency(120)).toBe(100);
    expect(normalizeWindowTransparency(-5)).toBe(0);
    expect(normalizeWindowTransparency("42.4")).toBe(42);
    expect(normalizeWindowTransparency("nope")).toBe(
      DEFAULT_WINDOW_TRANSPARENCY,
    );
  });

  it("opacity and transparency are inverse projections", () => {
    expect(windowOpacityFromTransparency(65)).toBe(35);
    expect(windowTransparencyFromOpacity(35)).toBe(65);
    expect(
      windowTransparencyFromOpacity(windowOpacityFromTransparency(0)),
    ).toBe(0);
    expect(windowTransparencyFromOpacity("bad")).toBe(
      DEFAULT_WINDOW_TRANSPARENCY,
    );
  });
});
