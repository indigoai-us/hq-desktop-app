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

/** True when the sender person-uid identifies a fleet agent (agt_/agent_/agent: prefixes). Falls back to false when no uid metadata exists (known limitation: legacy rows can't be classified). */
export function isAgentSender(item: Item): boolean {
  const uid =
    item.kind === 'dm' ? item.dm?.fromPersonUid : item.share?.issuerPersonUid;
  const u = (uid ?? '').trim();
  return u.startsWith('agt_') || u.startsWith('agent_') || u.startsWith('agent:');
}

/** Conversation identity: kind + stable sender key (person uid, else email, else display actor). DM and share threads from the same person stay distinct rows by design (type hierarchy). */
export function conversationKey(item: Item): string {
  const who =
    item.kind === 'dm'
      ? item.dm?.fromPersonUid || item.dm?.fromEmail || item.actor
      : item.share?.issuerPersonUid || item.share?.issuerEmail || item.actor;
  return `${item.kind}:${who}`;
}

export interface ConversationRow {
  key: string;
  kind: 'dm' | 'share';
  actor: string;
  /** Newest item in the conversation — preview text + timestamp + selection target. */
  latest: Item;
  /** All member item ids (newest-first) — selection highlight + viewed-marking. */
  ids: string[];
  /** All member items (newest-first) — lets the main pane render the whole
   *  conversation (e.g. every share from this sender), not just the latest. */
  items: Item[];
  unreadCount: number;
  agent: boolean;
}

const PANE_ROW_CAP = 30;

/** Group pane items (expected newest-first) into ONE row per conversation.
 *  First item seen per key is the latest; unreadCount counts member items that
 *  are rowUnread(...). Rows keep first-seen (newest-first) order, capped at 30. */
export function conversationRows(
  items: Item[],
  lastReadTs: number,
  viewedIds: ReadonlySet<string>,
): ConversationRow[] {
  const order: string[] = [];
  const byKey = new Map<string, ConversationRow>();

  for (const item of items) {
    if (item.kind !== 'dm' && item.kind !== 'share') continue;
    const key = conversationKey(item);
    const unread = rowUnread(item, lastReadTs, viewedIds) ? 1 : 0;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        kind: item.kind,
        actor: item.actor,
        latest: item,
        ids: [item.id],
        items: [item],
        unreadCount: unread,
        agent: isAgentSender(item),
      });
      order.push(key);
    } else {
      existing.ids.push(item.id);
      existing.items.push(item);
      existing.unreadCount += unread;
    }
  }

  return order.slice(0, PANE_ROW_CAP).map((k) => byKey.get(k)!);
}
