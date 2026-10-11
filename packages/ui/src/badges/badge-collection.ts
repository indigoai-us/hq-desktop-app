/**
 * The Badges page: every badge in the catalog, grouped by tier, earned ones
 * first, the rest locked with what earns them and plain progress.
 *
 * A locked badge sits in the tier its first level would give: Bronze for the
 * three-level badges, the badge's own tier for single-level and limited ones.
 */

import { BADGES, TIER_NAME, resolveEarned, type BadgeDef, type BadgeTier, type EarnedBadge, type ResolvedBadge } from "./badge-catalog.js";
import type { BadgeProgress } from "./badge-source.js";

export interface CollectionTile {
  def: BadgeDef;
  tier: BadgeTier;
  /** The earned badge, or null while it is locked. */
  earned: ResolvedBadge | null;
  /** Locked only: "3 of 5 skills", "Not started", or "No longer available". */
  progress: string;
}

export interface CollectionGroup {
  tier: BadgeTier;
  label: string;
  earned: number;
  tiles: CollectionTile[];
}

const ORDER: BadgeTier[] = ["L", 3, 2, 1];

/** The tier a locked badge would first be earned at. */
export function firstTier(def: BadgeDef): BadgeTier {
  return def.levels.split(" · ").length >= 3 ? 1 : def.tier;
}

const fmt = (n: number) => Math.max(0, Math.floor(n)).toLocaleString("en-US");

/** Plain progress toward a locked badge. */
export function progressText(def: BadgeDef, progress?: BadgeProgress | null): string {
  if (/^limited/i.test(def.levels)) return "No longer available";
  if (!progress || !(progress.target > 0) || !(progress.current > 0)) return "Not started";
  const unit = progress.target === 1 ? progress.unit.replace(/s$/, "") : progress.unit;
  return `${fmt(Math.min(progress.current, progress.target))} of ${fmt(progress.target)} ${unit}`.trim();
}

export function badgeCollection(earned: readonly EarnedBadge[], progress: readonly BadgeProgress[] = []): CollectionGroup[] {
  const have = resolveEarned(earned);
  const byId = new Map(have.map((b) => [b.def.id, b]));
  const prog = new Map(progress.map((p) => [p.id, p]));
  const tiles: CollectionTile[] = [
    ...have.map((b) => ({ def: b.def, tier: b.tier, earned: b, progress: "" })),
    ...BADGES.filter((def) => !byId.has(def.id)).map((def) => ({
      def,
      tier: firstTier(def),
      earned: null,
      progress: progressText(def, prog.get(def.id)),
    })),
  ];
  return ORDER.map((tier) => {
    const inTier = tiles.filter((t) => t.tier === tier);
    return { tier, label: TIER_NAME[tier], earned: inTier.filter((t) => t.earned).length, tiles: inTier };
  }).filter((g) => g.tiles.length > 0);
}
