/**
 * Pure audience-filter helpers for the "Show bot messages" toggle (US-006).
 * No Svelte / DOM deps — importable by both components and tests.
 */

export const SHOW_BOT_MESSAGES_KEY = 'hq:messages:show-bot-messages';

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

/** Read the persisted toggle value; defaults to false (off). */
export function readShowBotMessages(): boolean {
  try {
    return localStorage.getItem(SHOW_BOT_MESSAGES_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Persist the toggle value to localStorage. */
export function writeShowBotMessages(value: boolean): void {
  try {
    if (value) {
      localStorage.setItem(SHOW_BOT_MESSAGES_KEY, 'true');
    } else {
      localStorage.removeItem(SHOW_BOT_MESSAGES_KEY);
    }
  } catch {
    // localStorage unavailable (e.g. test env without happy-dom)
  }
}
