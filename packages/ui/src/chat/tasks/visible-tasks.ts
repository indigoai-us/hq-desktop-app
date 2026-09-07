import type { AgentTask } from "./agent-tasks";

/** How long a finished task keeps its chip after its last event. */
export const RECENT_TERMINAL_MS = 15 * 60 * 1000;

const LIVE = new Set(["queued", "working", "waiting"]);

/**
 * What the strip shows: every live task, plus finished ones for a short
 * window after they finish so the hand-off is visible — then they drop
 * off. A finished task without a last-event time (the agent-wide view's
 * failures) is treated as recent, since that view already bounds them.
 */
export function visibleTasks(tasks: readonly AgentTask[], now: number = Date.now()): AgentTask[] {
  return tasks.filter((t) => {
    if (LIVE.has(t.status)) return true;
    if (!t.lastEventAt) return true;
    const at = Date.parse(t.lastEventAt);
    return Number.isNaN(at) ? false : now - at <= RECENT_TERMINAL_MS;
  });
}
