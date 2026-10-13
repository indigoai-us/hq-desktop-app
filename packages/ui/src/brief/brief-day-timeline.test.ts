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
  it("keeps two finished calls for context, marks the next call active and the rest later", () => {
    const events = [ev("a", 7), ev("b", 8), ev("c", 9), ev("d", 11), ev("e", 13), ev("f", 15)];
    const { steps, hidden } = daySteps(events, at(10));
    expect(steps.map((s) => [s.e.id, s.state])).toEqual([
      ["b", "done"],
      ["c", "done"],
      ["d", "next"],
      ["e", "later"],
      ["f", "later"],
    ]);
    expect(hidden.map((e) => e.id)).toEqual(["a"]);
  });

  it("says Now for a call in progress, skips busy holds, and fills with past calls late in the day", () => {
    const events = [ev("a", 9), ev("hold", 10, 0, { busy: true }), ev("b", 11), ev("c", 13), ev("d", 16)];
    expect(daySteps(events, at(16, 10)).steps.map((s) => [s.e.id, s.state])).toEqual([
      ["a", "done"],
      ["b", "done"],
      ["c", "done"],
      ["d", "now"],
    ]);
  });

  it("is empty with no calls", () => {
    expect(daySteps([], at(9))).toEqual({ steps: [], hidden: [] });
  });
});
