import { describe, expect, it } from "vitest";
import { distillTimeline, isBackgroundSession } from "./brief-timeline.js";

const NOW = "2026-10-09T20:00:00.000Z";
const at = (hoursAgo: number, min = 0) => new Date(Date.parse(NOW) - hoursAgo * 3600_000 + min * 60_000).toISOString();

describe("distillTimeline", () => {
  it("drops background maintenance sessions and counts them separately", () => {
    const t = distillTimeline(
      [
        { at: at(1), title: "HQ checkpoint sibling — a background maintenance agent for this HQ install" },
        { at: at(2), title: "Auto: checkpoint" },
        { at: at(3), title: "Daily Brief layout" },
      ],
      NOW,
    );
    expect(t.work).toBe(1);
    expect(t.background).toBe(2);
    expect(t.latest?.title).toBe("Daily Brief layout");
  });

  it("buckets by hour across the last 24 hours and ignores older sessions", () => {
    const t = distillTimeline(
      [
        { at: at(0.5), title: "a" },
        { at: at(0.5, -10), title: "b" },
        { at: at(23.5), title: "c" },
        { at: at(30), title: "too old" },
      ],
      NOW,
    );
    expect(t.buckets).toHaveLength(24);
    expect(t.buckets[23]!.count).toBe(2);
    expect(t.buckets[0]!.count).toBe(1);
    expect(t.work).toBe(3);
  });

  it("keeps at most three titles per hour, newest first", () => {
    const s = [0, 5, 10, 15].map((m) => ({ at: at(1, m), title: `s${m}` }));
    const b = distillTimeline(s, NOW).buckets.find((x) => x.count)!;
    expect(b.count).toBe(4);
    expect(b.titles).toEqual(["s15", "s10", "s5"]);
  });

  it("does not treat ordinary titles as background", () => {
    expect(isBackgroundSession("Fix checkpoint button copy")).toBe(false);
  });
});
