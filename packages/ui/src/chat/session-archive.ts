/**
 * Archive state for sidebar sessions (the rail's conversation rows: project
 * channels, DMs, group DMs, and agent/bot conversations).
 *
 * Archiving hides a row from the default rail. It never deletes anything and
 * never touches unread state, so unarchiving restores the row exactly as it
 * was. Persistence is renderer-local and tenant-scoped by the caller's
 * `createTenantStorage` facade — hq-pro has no per-user conversation archive
 * flag today (see the PR body), so archive state does not follow the account
 * across devices yet.
 */

import type { ConversationRow } from "./sidebar-model";

export const ARCHIVED_STORAGE_KEY = "hq.chat.archived";
export const SHOW_ARCHIVED_STORAGE_KEY = "hq.chat.show-archived";

function uniqueStrings(values: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const id = typeof value === "string" ? value.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function loadArchived(
  storage: Pick<Storage, "getItem"> | null | undefined,
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(ARCHIVED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return uniqueStrings(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return [];
  }
}

export function saveArchived(
  ids: readonly string[],
  storage: Pick<Storage, "setItem"> | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(ARCHIVED_STORAGE_KEY, JSON.stringify(uniqueStrings(ids)));
  } catch {
    // Quota / private mode — best-effort.
  }
}

export function loadShowArchived(
  storage: Pick<Storage, "getItem"> | null | undefined,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SHOW_ARCHIVED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowArchived(
  show: boolean,
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
): void {
  if (!storage) return;
  try {
    if (show) storage.setItem(SHOW_ARCHIVED_STORAGE_KEY, "1");
    else storage.removeItem(SHOW_ARCHIVED_STORAGE_KEY);
  } catch {
    // Quota / private mode — best-effort.
  }
}

/** Add ids to the archive. Order is stable; duplicates collapse. */
export function archiveConversations(
  current: readonly string[],
  ids: Iterable<string>,
): string[] {
  return uniqueStrings([...current, ...ids]);
}

/** Remove ids from the archive. */
export function unarchiveConversations(
  current: readonly string[],
  ids: Iterable<string>,
): string[] {
  const drop = new Set(uniqueStrings(ids));
  return uniqueStrings(current).filter((id) => !drop.has(id));
}

export function isArchived(
  archived: ReadonlySet<string> | readonly string[],
  conversationId: string,
): boolean {
  const set = archived instanceof Set ? archived : new Set(archived);
  return set.has(conversationId);
}

/**
 * Default rail hides archived rows. With `showArchived` on, every row stays —
 * the component paints the archived ones with a muted "Archived" pill.
 */
export function filterByArchived(
  rows: readonly ConversationRow[],
  archived: ReadonlySet<string> | readonly string[],
  showArchived: boolean,
): ConversationRow[] {
  if (showArchived) return rows.slice();
  const set = archived instanceof Set ? archived : new Set(archived);
  if (set.size === 0) return rows.slice();
  return rows.filter((row) => !set.has(row.id));
}

/** Archived ids that still have a live row — used for the toolbar label. */
export function archivedRowCount(
  rows: readonly ConversationRow[],
  archived: ReadonlySet<string> | readonly string[],
): number {
  const set = archived instanceof Set ? archived : new Set(archived);
  if (set.size === 0) return 0;
  return rows.reduce((total, row) => (set.has(row.id) ? total + 1 : total), 0);
}
