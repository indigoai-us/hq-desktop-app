/**
 * Pure helpers for the quick-window left side pane (US-011).
 *
 * Share-detail and dm-detail notification windows share a side-pane of recent
 * DMs + shares. These helpers stay framework-free so they unit-test cleanly
 * and stay out of the Svelte component lifecycle.
 */

import type { Item } from './notificationGroups';
import { isUnread } from './notificationFeedData';

/** Max rows shown in a quick-window side pane (newest-first feed is already sorted). */
const PANE_ITEM_CAP = 30;

/**
 * Keep only kinds that have an in-window main pane (`dm` / `share`).
 * `new-file` rows open a different surface and are excluded. Preserves input
 * order (expected newest-first) and caps at 30.
 */
export function paneItems(items: Item[]): Item[] {
  return items.filter((it) => it.kind === 'dm' || it.kind === 'share').slice(0, PANE_ITEM_CAP);
}

/**
 * Unread for a pane row: newer than the watermark AND not yet viewed in this
 * quick-window session. Viewing a row (open selection / opening event) clears
 * its dot without advancing the global watermark.
 */
export function rowUnread(
  item: Item,
  lastReadTs: number,
  viewedIds: ReadonlySet<string>,
): boolean {
  return isUnread(item, lastReadTs) && !viewedIds.has(item.id);
}

/**
 * Default selected id for the opening event when the user has not clicked a
 * side-pane row. Mirrors `Item.id` shape from notificationFeedData.
 */
export function defaultSelectedId(
  kind: 'share' | 'dm',
  eventId: string | undefined,
): string | null {
  if (!eventId) return null;
  return `${kind}:${eventId}`;
}
