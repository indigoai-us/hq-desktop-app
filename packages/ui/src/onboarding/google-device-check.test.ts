import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_DEVICE_CHECK_AFTER_MS,
  GOOGLE_DEVICE_CHECK_COPY,
  armGoogleDeviceCheck,
  isGoogleBrowserSignIn,
  showGoogleDeviceCheck,
} from "./google-device-check.js";

const COPY = "Google may ask you to confirm it's you on your phone. That is Google's own check.";

describe("google device check (US-013)", () => {
  it("uses the decided sentence, with no exclamation mark or em dash", () => {
    expect(GOOGLE_DEVICE_CHECK_COPY).toBe(COPY);
    expect(GOOGLE_DEVICE_CHECK_COPY).not.toMatch(/[!—]/);
    expect(GOOGLE_DEVICE_CHECK_AFTER_MS).toBe(10_000);
  });

  it("is only a Google sign-in: HQ Google and Claude Code, not Microsoft, Codex or Grok", () => {
    expect(isGoogleBrowserSignIn({ provider: "Google" })).toBe(true);
    expect(isGoogleBrowserSignIn({ provider: "Microsoft" })).toBe(false);
    expect(isGoogleBrowserSignIn({ runtime: "claude" })).toBe(true);
    expect(isGoogleBrowserSignIn({ runtime: "codex" })).toBe(false);
    expect(isGoogleBrowserSignIn({ runtime: "grok" })).toBe(false);
    expect(isGoogleBrowserSignIn({})).toBe(false);
  });

  it("shows only while a Google browser wait has lasted 10 seconds", () => {
    expect(showGoogleDeviceCheck({ google: true, waitingOnBrowser: true, elapsedMs: 9_999 })).toBe(false);
    expect(showGoogleDeviceCheck({ google: true, waitingOnBrowser: true, elapsedMs: 10_000 })).toBe(true);
    expect(showGoogleDeviceCheck({ google: true, waitingOnBrowser: false, elapsedMs: 20_000 })).toBe(false);
    expect(showGoogleDeviceCheck({ google: false, waitingOnBrowser: true, elapsedMs: 20_000 })).toBe(false);
  });

  it("arms the line after 10 seconds and drops it when the wait ends", () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const stop = armGoogleDeviceCheck(() => shown.push("shown"));
    vi.advanceTimersByTime(9_999);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(["shown"]);
    stop();
    vi.useRealTimers();
  });

  it("does not show the line if the wait ends before 10 seconds", () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const stop = armGoogleDeviceCheck(() => shown.push("shown"));
    vi.advanceTimersByTime(9_999);
    stop();
    vi.advanceTimersByTime(5_000);
    expect(shown).toEqual([]);
    vi.useRealTimers();
  });
});
