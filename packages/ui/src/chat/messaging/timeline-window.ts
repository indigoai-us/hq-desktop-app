/**
 * Newest-window for a conversation timeline (oldest → newest).
 *
 * Opening a thread must not mount/markdown the whole history. The rail
 * already lazy-loads older conversations; the thread does the same for
 * older messages. "Show earlier" raises `extra`.
 */

export const TIMELINE_WINDOW = 20;

export function takeNewestWindow<T>(
  messages: readonly T[],
  options: { limit?: number; extra?: number } = {},
): { hidden: number; rows: T[] } {
  const limit = options.limit ?? TIMELINE_WINDOW;
  const extra = Math.max(0, options.extra ?? 0);
  const keep = limit + extra;
  if (messages.length <= keep) {
    return { hidden: 0, rows: messages.slice() };
  }
  const hidden = messages.length - keep;
  return { hidden, rows: messages.slice(hidden) };
}
