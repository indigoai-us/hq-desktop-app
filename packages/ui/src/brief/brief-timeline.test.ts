import { describe, expect, it } from "vitest";
import { distillTimeline, isBackgroundSession, sessionPeek } from "./brief-timeline.js";

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

  it("drops probe sessions and returns kept sessions oldest first, one per dot", () => {
    const t = distillTimeline(
      [
        { at: at(1), title: "Reply only OK. Do not use tools.", id: "p" },
        { at: at(2), title: "Daily brief design", id: "b" },
        { at: at(5), title: "Storage settings", id: "a" },
      ],
      NOW,
    );
    expect(t.items.map((s) => s.id)).toEqual(["a", "b"]);
    expect(t.background).toBe(1);
  });

  it("does not treat ordinary titles as background", () => {
    expect(isBackgroundSession("Fix checkpoint button copy")).toBe(false);
  });
});

describe("sessionPeek", () => {
  it("names the session's project in the status line and the Resume prompt when it has one", () => {
    const p = sessionPeek({ at: at(2), title: "Daily brief design", id: "s1", company: "cmp_indigo", project: "daily-brief" }, 0, 3);
    expect(p.status).toMatch(/^\d{1,2}:\d{2} (AM|PM) · session 1 of 3 · daily-brief$/);
    expect(p.prompt!.text).toContain('my session "Daily brief design" in the daily-brief project');
    expect(p.prompt!.text).toContain("Open the daily-brief project first.");
    expect(p.prompt!.text).toContain("id s1");
  });

  it("leaves the project out when the session has none or it is blank", () => {
    for (const project of [undefined, null, "  "]) {
      const p = sessionPeek({ at: at(2), title: "Storage settings", id: "s2", project }, 1, 2);
      expect(p.status).toMatch(/· session 2 of 2$/);
      expect(p.prompt!.text).not.toContain("project");
    }
  });
});
