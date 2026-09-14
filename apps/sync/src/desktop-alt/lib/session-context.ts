import type { SessionEvent } from '../../components/sessions/session-events';
export interface SessionContext {
  sourceSessionId: string | null;
  sourceTitle: string | null;
  startedBy: string | null;
  history: { events: { event: SessionEvent; receivedAtMs: number }[]; before: number | null };
}

/** Replay rings evict a prefix. Keep precisely the inherited prefix missing
 * from the current replay; timestamps distinguish repeated operator prompts. */
export function missingInheritedPrefix(context: SessionContext | null, events: readonly SessionEvent[], stamps: readonly (number | null)[]) {
  const inherited = context?.history?.events ?? [];
  const visibleKey = (event: SessionEvent, stamp: number | null) =>
    (event && (event.kind === 'userMessage' || event.kind === 'assistantMessage'))
      ? JSON.stringify([event.kind, event.text, stamp]) : null;
  const present = new Set(events.map((event, index) => visibleKey(event, stamps[index] ?? null)).filter(Boolean));
  const overlap = inherited.findIndex(item => present.has(visibleKey(item.event, item.receivedAtMs)));
  return overlap < 0 ? inherited : inherited.slice(0, overlap);
}
