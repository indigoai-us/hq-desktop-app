/**
 * More companies popover (console-rail US-005).
 *
 * The list is filtered on the client from the roster the shell already
 * cached. Opening the popover does not fetch. Pin order stays on this
 * device and never exceeds six tiles.
 */

import { MAX_PINNED_COMPANY_TILES } from "./app-rail.js";

export interface MoreCompany {
  uid: string;
  name: string;
  slug: string;
  iconUrl?: string | null;
  liveCount: number;
}

export interface MoreCompaniesSections {
  pinned: MoreCompany[];
  recent: MoreCompany[];
  /** Companies not already shown under Pinned or Recent. */
  all: MoreCompany[];
  /** Matching companies, including ones listed above. */
  matchCount: number;
  pinnedCount: number;
  pinLimit: number;
}

/**
 * Scroll budget for this list. The popover is a short overflow region; rows
 * stay cheap (no images beyond the existing company mark, no observers).
 */
export const metadata = {
  performanceBudget: {
    scrollDroppedFramesPct: 0.01,
    worstFrameMs: 33,
  },
};

function matches(company: MoreCompany, query: string): boolean {
  if (!query) return true;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    company.name.toLowerCase().includes(needle) ||
    company.slug.toLowerCase().includes(needle)
  );
}

export function moreCompaniesSections(
  companies: readonly MoreCompany[],
  pinnedIds: readonly string[],
  recentIds: readonly string[],
  query = "",
  pinLimit = MAX_PINNED_COMPANY_TILES,
): MoreCompaniesSections {
  const byUid = new Map<string, MoreCompany>();
  for (const company of companies) {
    const uid = company.uid.trim();
    if (!uid || byUid.has(uid)) continue;
    byUid.set(uid, company);
  }
  const pinned: MoreCompany[] = [];
  for (const id of pinnedIds) {
    const company = byUid.get(id);
    if (!company || !matches(company, query)) continue;
    pinned.push(company);
    if (pinned.length >= pinLimit) break;
  }
  const pinnedSet = new Set(pinnedIds);
  const recent: MoreCompany[] = [];
  const recentSet = new Set<string>();
  for (const id of recentIds) {
    if (pinnedSet.has(id) || recentSet.has(id)) continue;
    const company = byUid.get(id);
    if (!company || !matches(company, query)) continue;
    recent.push(company);
    recentSet.add(id);
  }
  const shown = new Set<string>([...pinned.map((c) => c.uid), ...recentSet]);
  const all: MoreCompany[] = [];
  let matchCount = 0;
  for (const company of byUid.values()) {
    if (!matches(company, query)) continue;
    matchCount += 1;
    if (!shown.has(company.uid)) all.push(company);
  }
  return {
    pinned,
    recent,
    all,
    matchCount,
    pinnedCount: pinnedIds.filter((id) => byUid.has(id)).length,
    pinLimit,
  };
}

export type PinResult =
  | { status: "pinned"; ids: string[] }
  | { status: "replace"; ids: string[] }
  | { status: "unchanged"; ids: string[] };

/** Pin when there is room. A seventh pin asks which tile to replace. */
export function pinCompany(
  pinnedIds: readonly string[],
  uid: string,
  limit = MAX_PINNED_COMPANY_TILES,
): PinResult {
  const id = uid.trim();
  const ids = pinnedIds.filter((entry, index) => entry.trim() && pinnedIds.indexOf(entry) === index);
  if (!id || ids.includes(id)) return { status: "unchanged", ids };
  if (ids.length >= limit) return { status: "replace", ids };
  return { status: "pinned", ids: [...ids, id] };
}

export function replacePinnedCompany(
  pinnedIds: readonly string[],
  removeUid: string,
  addUid: string,
  limit = MAX_PINNED_COMPANY_TILES,
): string[] {
  const add = addUid.trim();
  const remove = removeUid.trim();
  if (!add || !remove || add === remove) return [...pinnedIds];
  if (!pinnedIds.includes(remove)) return [...pinnedIds];
  const next = pinnedIds.filter((id) => id !== remove && id !== add);
  const at = pinnedIds.indexOf(remove);
  next.splice(Math.min(at, next.length), 0, add);
  return next.slice(0, limit);
}

export function unpinCompany(pinnedIds: readonly string[], uid: string): string[] {
  const id = uid.trim();
  if (!id) return [...pinnedIds];
  return pinnedIds.filter((entry) => entry !== id);
}
