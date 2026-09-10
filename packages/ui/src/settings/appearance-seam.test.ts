import { describe, expect, it } from "vitest";
import { normalizeColorTheme } from "./appearance-seam";

describe("appearance value contracts (desktop appearancePreferences port)", () => {
  it("normalizes color themes to the system default", () => {
    expect(normalizeColorTheme("light")).toBe("light");
    expect(normalizeColorTheme("dark")).toBe("dark");
    expect(normalizeColorTheme("mauve")).toBe("system");
    expect(normalizeColorTheme(undefined)).toBe("system");
  });
});
