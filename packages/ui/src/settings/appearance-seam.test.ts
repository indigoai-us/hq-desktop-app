import { describe, expect, it } from "vitest";
import {
  APPEARANCE_RECORD_VERSION,
  DEFAULT_WINDOW_TRANSPARENCY,
  LEGACY_DEFAULT_WINDOW_TRANSPARENCY,
  MAX_WINDOW_TRANSPARENCY,
  parseStoredAppearance,
  serializeStoredAppearance,
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
    // Transparency shares the slider's range (opacity 35..100).
    expect(MAX_WINDOW_TRANSPARENCY).toBe(65);
    expect(normalizeWindowTransparency(120)).toBe(65);
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

describe("default window opacity", () => {
  // Regression: fresh installs shipped at transparency 65 (35% opacity) in the
  // host while the Settings pref defaulted to 80%. One default now: solid.
  it("is 100% opaque", () => {
    expect(DEFAULT_WINDOW_TRANSPARENCY).toBe(0);
    expect(windowOpacityFromTransparency(DEFAULT_WINDOW_TRANSPARENCY)).toBe(100);
    expect(parseStoredAppearance(null).record).toEqual({
      colorTheme: "system",
      windowTransparency: 0,
      windowTransparencySet: false,
    });
  });
});

describe("stored appearance upgrade", () => {
  const legacy = (value: unknown) =>
    JSON.stringify({ colorTheme: "dark", windowTransparency: value });

  it("resets the old app-written default (65) to solid and keeps the theme", () => {
    const { record, migrated } = parseStoredAppearance(
      legacy(LEGACY_DEFAULT_WINDOW_TRANSPARENCY),
    );
    expect(migrated).toBe(true);
    expect(record).toEqual({
      colorTheme: "dark",
      windowTransparency: 0,
      windowTransparencySet: false,
    });
  });

  it("keeps a legacy value the user chose with the slider", () => {
    const { record, migrated } = parseStoredAppearance(legacy(20));
    expect(migrated).toBe(true);
    expect(record.windowTransparency).toBe(20);
    expect(record.windowTransparencySet).toBe(true);
  });

  it("clamps an out-of-range legacy value into the slider range", () => {
    expect(parseStoredAppearance(legacy(90)).record.windowTransparency).toBe(65);
  });

  it("treats a malformed legacy value as unset", () => {
    expect(parseStoredAppearance(legacy("nope")).record).toMatchObject({
      windowTransparency: 0,
      windowTransparencySet: false,
    });
    expect(parseStoredAppearance("{not json").record.windowTransparency).toBe(0);
  });

  it("round-trips a v2 record without migrating it again", () => {
    const raw = serializeStoredAppearance({
      colorTheme: "light",
      windowTransparency: 65,
      windowTransparencySet: true,
    });
    expect(JSON.parse(raw).v).toBe(APPEARANCE_RECORD_VERSION);
    // 65 chosen explicitly in v2 is kept: only LEGACY records are guessed at.
    expect(parseStoredAppearance(raw)).toEqual({
      record: { colorTheme: "light", windowTransparency: 65, windowTransparencySet: true },
      migrated: false,
    });
  });

  it("ignores a v2 transparency the user never chose", () => {
    const raw = JSON.stringify({
      v: APPEARANCE_RECORD_VERSION,
      colorTheme: "system",
      windowTransparency: 40,
      windowTransparencySet: false,
    });
    expect(parseStoredAppearance(raw).record.windowTransparency).toBe(0);
  });
});
