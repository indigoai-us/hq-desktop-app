import { describe, expect, it } from "vitest";

import {
  readOnboardingHostOs,
  setupExpectationCopy,
} from "./onboarding-platform";

describe("readOnboardingHostOs", () => {
  it("reads Windows out of the Tauri webview UA", () => {
    expect(
      readOnboardingHostOs(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      ),
    ).toBe("windows");
  });

  it("reads macOS out of the WebKit UA", () => {
    expect(
      readOnboardingHostOs(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      ),
    ).toBe("macos");
  });

  it("reads Linux out of the UA and does not confuse an Android UA for Linux", () => {
    expect(
      readOnboardingHostOs("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537"),
    ).toBe("linux");
    expect(
      readOnboardingHostOs("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537"),
    ).toBe("unknown");
  });

  it("is 'unknown' when nothing recognisable is present", () => {
    expect(readOnboardingHostOs("")).toBe("unknown");
    expect(readOnboardingHostOs(null)).toBe("unknown");
    expect(readOnboardingHostOs(undefined)).toBe("unknown");
    expect(readOnboardingHostOs("Something Else/1.0")).toBe("unknown");
  });
});

describe("setupExpectationCopy", () => {
  it("gives Windows users the honest 'this takes longer' line", () => {
    const copy = setupExpectationCopy("windows");
    expect(copy).toMatch(/Windows/);
    expect(copy).toMatch(/longer|minutes/i);
    // Nothing about a fake progress bar or a hard deadline.
    expect(copy).not.toMatch(/exactly|\d+%/i);
  });

  it("names no OS in the Mac line — the wording is a plain, honest expectation", () => {
    const copy = setupExpectationCopy("macos");
    expect(copy).not.toMatch(/\bWindows\b/i);
    expect(copy).toMatch(/minutes/i);
  });

  it("falls back to neutral copy for Linux or unknown, and never says 'your Mac'", () => {
    for (const os of ["linux", "unknown"] as const) {
      const copy = setupExpectationCopy(os);
      expect(copy).not.toMatch(/\bMac(OS)?\b/i);
      expect(copy).not.toMatch(/\bWindows\b/i);
      expect(copy).toMatch(/minutes/i);
    }
  });
});
