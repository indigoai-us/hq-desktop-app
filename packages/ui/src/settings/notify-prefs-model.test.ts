import { describe, expect, it } from "vitest";

import {
  PAUSE_CHOICES,
  PREF_TOGGLES,
  applyPrefsPatch,
  describePause,
  isPauseActive,
  normalizeNotifyPrefs,
  pausedUntilFor,
  prefsFailureState,
  prefsSaveErrorMessage,
  tomorrowAtEight,
} from "./notify-prefs-model";

const NOW = new Date(2026, 8, 23, 15, 30, 0); // local 15:30

describe("pause choices", () => {
  it("offers off, 1h, 8h, tomorrow 8am, and indefinitely", () => {
    expect(PAUSE_CHOICES.map((c) => c.id)).toEqual(["off", "1h", "8h", "tomorrow", "forever"]);
  });

  it("computes pausedUntil as ISO Z, forever, or null", () => {
    expect(pausedUntilFor("off", NOW)).toBeNull();
    expect(pausedUntilFor("forever", NOW)).toBe("forever");
    const oneHour = pausedUntilFor("1h", NOW)!;
    expect(oneHour).toMatch(/Z$/);
    expect(Date.parse(oneHour) - NOW.getTime()).toBe(3_600_000);
    expect(Date.parse(pausedUntilFor("8h", NOW)!) - NOW.getTime()).toBe(8 * 3_600_000);
  });

  it("pauses until 8am local tomorrow", () => {
    const until = new Date(Date.parse(pausedUntilFor("tomorrow", NOW)!));
    expect(until.getDate()).toBe(24);
    expect(until.getHours()).toBe(8);
    expect(until.getMinutes()).toBe(0);
    // Just after midnight still means the next calendar day.
    const lateNight = new Date(2026, 8, 23, 0, 10);
    expect(tomorrowAtEight(lateNight).getDate()).toBe(24);
  });

  it("describes the pause state", () => {
    expect(describePause(null, NOW)).toBe("Notifications are on");
    expect(describePause("forever", NOW)).toBe("Paused until you turn it off");
    expect(describePause(new Date(2026, 8, 23, 10).toISOString(), NOW)).toBe(
      "Notifications are on",
    );
    expect(describePause(pausedUntilFor("1h", NOW), NOW)).toMatch(/^Paused until \d/);
    expect(describePause(pausedUntilFor("tomorrow", NOW), NOW)).toMatch(
      /^Paused until tomorrow at /,
    );
    expect(isPauseActive("garbage", NOW)).toBe(false);
  });
});

describe("prefs payloads", () => {
  it("normalizes the live envelope and fills server defaults", () => {
    expect(
      normalizeNotifyPrefs({
        prefs: {
          pausedUntil: null,
          dmsDuringPause: false,
          dms: true,
          mentions: true,
          files: true,
          allActivity: true,
          addedToChannel: true,
          updatedAt: "2026-09-23T19:19:03.904Z",
        },
        paused: false,
      }),
    ).toEqual({
      pausedUntil: null,
      dmsDuringPause: false,
      dms: true,
      mentions: true,
      files: true,
      allActivity: true,
      addedToChannel: true,
      updatedAt: "2026-09-23T19:19:03.904Z",
    });
    expect(normalizeNotifyPrefs({ prefs: {} })).toMatchObject({
      dmsDuringPause: false,
      dms: true,
      allActivity: true,
    });
    expect(normalizeNotifyPrefs(null)).toBeNull();
  });

  it("lists the six toggles", () => {
    expect(PREF_TOGGLES.map((t) => t.label)).toEqual([
      "Direct messages",
      "Mentions",
      "Files shared",
      "All activity",
      "Added to a channel",
      "Let DMs through while paused",
    ]);
  });

  it("merges a patch", () => {
    const base = normalizeNotifyPrefs({})!;
    expect(applyPrefsPatch(base, { dms: false }).dms).toBe(false);
    expect(applyPrefsPatch(base, { pausedUntil: "forever" }).pausedUntil).toBe("forever");
  });

  it("treats a 404 as unavailable, other failures as errors", () => {
    expect(prefsFailureState({ code: "http-404" })).toEqual({ kind: "unavailable" });
    expect(prefsFailureState({ code: "http-500", message: "boom" })).toEqual({
      kind: "error",
      message: "boom",
    });
    expect(prefsSaveErrorMessage({ code: "http-404" })).toMatch(/doesn't support/);
  });
});
