/**
 * Pure audience-filter helpers for DM threads (US-006). Bot (agent-audience)
 * messages stay hidden by default; a thread can reveal them on request.
 * No Svelte / DOM deps — importable by both components and tests.
 */

/** True when a message with the given audience should show in the human view. */
export function isHumanVisible(audience: string | null | undefined): boolean {
  // Absent = human (server default). "human" and "both" always show.
  return !audience || audience === 'human' || audience === 'both';
}

/** Filter a list, keeping only human-visible items when the toggle is off. */
export function filterByAudience<T extends { audience?: string | null }>(
  items: T[],
  showBotMessages: boolean,
): T[] {
  if (showBotMessages) return items;
  return items.filter((m) => isHumanVisible(m.audience));
}

/** Count items that would be hidden when the toggle is off. */
export function countHiddenByAudience<T extends { audience?: string | null }>(
  items: T[],
  showBotMessages: boolean,
): number {
  if (showBotMessages) return 0;
  return items.filter((m) => !isHumanVisible(m.audience)).length;
}
