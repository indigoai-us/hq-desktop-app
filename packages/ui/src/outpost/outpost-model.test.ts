import { describe, expect, it } from "vitest";
import {
  appendLogTail,
  clampJobAlert,
  fixtureOutpost,
  formatRetry,
  offlineBanner,
  previewCron,
  visibleLogWindow,
  JOB_ALERTS,
} from "./outpost-model.js";

describe("US-034 outpost model", () => {
  it("keeps job alerts to dm or none", () => {
    expect(JOB_ALERTS).toEqual(["dm", "none"]);
    expect(clampJobAlert("profile")).toBe("none");
    expect(clampJobAlert("dm")).toBe("dm");
    expect(clampJobAlert("slack")).toBe("none");
    expect(fixtureOutpost().jobs.every((job) => job.alert === "dm" || job.alert === "none")).toBe(true);
  });

  it("validates cron and previews the next five runs", () => {
    const from = new Date("2026-10-01T18:00:00Z");
    const good = previewCron("*/20 8-18 * * 1-5", from, 5);
    expect(good.ok).toBe(true);
    expect(good.next).toHaveLength(5);
    expect(good.next[0].toISOString()).toBe("2026-10-01T18:20:00.000Z");
    expect(good.next[1].toISOString()).toBe("2026-10-01T18:40:00.000Z");
    expect(good.next[2].toISOString()).toBe("2026-10-02T08:00:00.000Z");
    expect(good.next).toHaveLength(5);
    const bad = previewCron("not a cron", from, 5);
    expect(bad.ok).toBe(false);
    expect(bad.next).toHaveLength(0);
  });

  it("appends log lines without rewriting the tail and virtualizes the window", () => {
    const start = fixtureOutpost().logs;
    const next = appendLogTail(start, [
      start[0],
      { id: "l9", t: "10:16:01.004", level: "info", job: "outpost", message: "tail" },
    ]);
    expect(next).toHaveLength(start.length + 1);
    expect(next[0].id).toBe(start[0].id);
    const window = visibleLogWindow(1204, 2200, 280, 22, 0);
    expect(window.end - window.start).toBeLessThan(20);
    expect(window.start).toBeGreaterThan(90);
    expect(window.heightPx).toBe(1204 * 22);
  });

  it("shows the last heartbeat and a retry countdown when unreachable", () => {
    const cache = fixtureOutpost();
    cache.unreachable = true;
    cache.retryInSec = 22;
    cache.retryAttempt = 6;
    expect(formatRetry(22)).toBe("0:22");
    expect(offlineBanner(cache)).toContain("10:52");
    expect(offlineBanner(cache)).toContain("0:22");
    expect(offlineBanner(cache)).toContain("attempt 6");
  });
});
