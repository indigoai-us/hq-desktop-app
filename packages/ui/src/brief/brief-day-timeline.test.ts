// Today's calls as steps in the top centre: done, the active call, what follows; five rows at most.
import { describe, expect, it } from "vitest";
import { daySteps } from "./BriefDayTimeline.svelte";
import type { BriefCalendarEvent } from "./brief-types.js";

const ev = (id: string, h: number, m = 0, extra: Partial<BriefCalendarEvent> = {}): BriefCalendarEvent => {
  const start = new Date(2026, 9, 8, h, m);
  return { id, title: id, start: start.toISOString(), end: new Date(start.getTime() + 30 * 60_000).toISOString(), kind: "team", ...extra };
};
const at = (h: number, m = 0) => new Date(2026, 9, 8, h, m).toISOString();

describe("daySteps", () => {
  it("puts the next call in the middle: two finished calls above, two to come below, the rest behind +N more", () => {
    const events = [ev("a", 7), ev("b", 8), ev("c", 9), ev("d", 11), ev("e", 13), ev("f", 15), ev("g", 16)];
    const { steps, hidden } = daySteps(events, at(10));
    expect(steps.map((s) => [s.e.id, s.state])).toEqual([
      ["b", "done"],
      ["c", "done"],
      ["d", "next"],
      ["e", "later"],
      ["f", "later"],
    ]);
    expect(hidden.map((e) => e.id)).toEqual(["a", "g"]);
  });

  it("keeps the active call in the middle late in the day rather than filling with more past calls; skips busy holds", () => {
    const events = [ev("a", 9), ev("hold", 10, 0, { busy: true }), ev("b", 11), ev("c", 13), ev("d", 16), ev("e", 17)];
    expect(daySteps(events, at(16, 10)).steps.map((s) => [s.e.id, s.state])).toEqual([
      ["b", "done"],
      ["c", "done"],
      ["d", "now"],
      ["e", "later"],
    ]);
  });

  it("early in the day, with nothing behind it, the next call leads and upcoming calls fill the list", () => {
    const events = [ev("a", 9), ev("b", 10), ev("c", 11), ev("d", 12), ev("e", 13), ev("f", 14)];
    expect(daySteps(events, at(8)).steps.map((s) => [s.e.id, s.state])).toEqual([
      ["a", "next"],
      ["b", "later"],
      ["c", "later"],
      ["d", "later"],
      ["e", "later"],
    ]);
  });

  it("shows the last five calls once nothing is left today", () => {
    const events = [ev("a", 8), ev("b", 9), ev("c", 10), ev("d", 11), ev("e", 12), ev("f", 13)];
    const { steps, hidden } = daySteps(events, at(18));
    expect(steps.map((s) => s.e.id)).toEqual(["b", "c", "d", "e", "f"]);
    expect(steps.every((s) => s.state === "done")).toBe(true);
    expect(hidden.map((e) => e.id)).toEqual(["a"]);
  });

  it("is empty with no calls", () => {
    expect(daySteps([], at(9))).toEqual({ steps: [], hidden: [] });
  });
});
