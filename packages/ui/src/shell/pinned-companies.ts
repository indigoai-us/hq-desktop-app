/**
 * Pinned company tiles (console-rail US-004).
 *
 * Pin order is manual and stored per device in settings-prefs. The first
 * run seeds the default company, then the next most recently used, up to
 * six. Live dots read an already-built presence snapshot; this module
 * never polls.
 */

import { MAX_PINNED_COMPANY_TILES } from "./app-rail.js";

export interface PinnableCompany {
  uid: string;
}

export function seedPinnedCompanyIds(
  companies: readonly PinnableCompany[],
  options: {
    defaultCompanyId?: string | null;
    recentIds?: readonly string[];
    limit?: number;
  } = {},
): string[] {
  const limit = options.limit ?? MAX_PINNED_COMPANY_TILES;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const company of companies) {
    const uid = company.uid.trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    ids.push(uid);
  }
  if (ids.length === 0 || limit <= 0) return [];
  const preferred = options.defaultCompanyId?.trim() ?? "";
  const def = preferred && ids.includes(preferred) ? preferred : ids[0]!;
  const recentRank = new Map(
    (options.recentIds ?? []).map((id, index) => [id, index] as const),
  );
  const rest = ids
    .filter((id) => id !== def)
    .sort((a, b) => {
      const rankA = recentRank.get(a) ?? Number.MAX_SAFE_INTEGER;
      const rankB = recentRank.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return ids.indexOf(a) - ids.indexOf(b);
    });
  return [def, ...rest].slice(0, limit);
}

/** Move `from` to the slot occupied by `to`. Unknown ids leave the list unchanged. */
export function reorderPinnedIds(
  ids: readonly string[],
  from: string,
  to: string,
): string[] {
  if (!from || !to || from === to) return [...ids];
  if (!ids.includes(from) || !ids.includes(to)) return [...ids];
  const next = ids.filter((id) => id !== from);
  next.splice(next.indexOf(to), 0, from);
  return next;
}

export function rememberCompanyId(
  recentIds: readonly string[],
  companyUid: string,
  limit = 12,
): string[] {
  const uid = companyUid.trim();
  if (!uid) return [...recentIds];
  return [uid, ...recentIds.filter((id) => id !== uid)].slice(0, limit);
}

/** Online people and bots already in the presence snapshot. */
export function companyLiveCount(
  snapshot: {
    get(companyUid: string): { values(): Iterable<{ status: string }> } | undefined;
  },
  companyUid: string,
): number {
  const actors = snapshot.get(companyUid);
  if (!actors) return 0;
  let count = 0;
  for (const entry of actors.values()) {
    if (entry.status === "online") count += 1;
  }
  return count;
}
