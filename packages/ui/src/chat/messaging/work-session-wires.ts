/**
 * Work-session card rendering helpers for channel conversations.
 *
 * Work-mesh posts a `work_session` system card per session; a long-running
 * session posts many, so the conversation keeps only the latest card per
 * session id. Extracted from the former `session-thread` module when the
 * in-app Sessions feature was removed — these are pure rendering helpers for
 * sessions running elsewhere, not for driving one locally.
 */

/** Keep the latest work_session card per mesh/desktop session id. */
export function coalesceWorkSessionWires<
  T extends { eventId: string; systemEvent?: unknown },
>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    const event = row.systemEvent;
    const sessionId =
      event &&
      typeof event === "object" &&
      (event as { type?: unknown }).type === "work_session"
        ? String((event as { sessionId?: unknown }).sessionId ?? "").trim()
        : "";
    if (sessionId) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
    }
    out.push(row);
  }
  return out.reverse();
}
