import { describe, expect, it } from "vitest";
import { RECENT_TERMINAL_MS, visibleTasks } from "./visible-tasks";
import type { AgentTask } from "./agent-tasks";

const NOW = Date.parse("2026-09-05T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("visibleTasks", () => {
  it("always shows live tasks", () => {
    const tasks: AgentTask[] = [
      { id: "q", title: "Q", status: "queued", lastEventAt: at(9e9) },
      { id: "w", title: "W", status: "working" },
      { id: "t", title: "T", status: "waiting", lastEventAt: at(9e9) },
    ];
    expect(visibleTasks(tasks, NOW).map((t) => t.id)).toEqual(["q", "w", "t"]);
  });

  it("keeps finished tasks only for a short window after their last event", () => {
    const tasks: AgentTask[] = [
      { id: "recent", title: "R", status: "done", lastEventAt: at(RECENT_TERMINAL_MS - 1000) },
      { id: "stale", title: "S", status: "done", lastEventAt: at(RECENT_TERMINAL_MS + 1000) },
      { id: "old-fail", title: "F", status: "failed", lastEventAt: at(3 * RECENT_TERMINAL_MS) },
    ];
    expect(visibleTasks(tasks, NOW).map((t) => t.id)).toEqual(["recent"]);
  });

  it("treats a finished task without a last-event time as recent, and an unparseable one as stale", () => {
    const tasks: AgentTask[] = [
      { id: "no-time", title: "N", status: "failed" },
      { id: "junk", title: "J", status: "done", lastEventAt: "not a date" },
    ];
    expect(visibleTasks(tasks, NOW).map((t) => t.id)).toEqual(["no-time"]);
  });
});
