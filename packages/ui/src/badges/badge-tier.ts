/**
 * The tier mark on a profile picture: the highest level someone has reached
 * across all their badges. A single-level badge counts at its own tier, so
 * Founding Member and Founder count as Gold.
 */

import { resolveEarned, type BadgeTier, type EarnedBadge, type ResolvedBadge } from "./badge-catalog.js";
import { badgesFor, type BadgeSubject } from "./badge-source.js";

const RANK: Readonly<Record<string, number>> = { 1: 1, 2: 2, 3: 3, L: 4 };

/**
 * The badge behind the mark: the one at the highest tier, the newest when
 * several share it. Null for none.
 */
export function topBadge(badges: readonly EarnedBadge[]): ResolvedBadge | null {
  let best: ResolvedBadge | null = null;
  // resolveEarned lists the newest first, so a later tie does not replace it.
  for (const b of resolveEarned(badges)) {
    if (best === null || (RANK[String(b.tier)] ?? 0) > (RANK[String(best.tier)] ?? 0)) best = b;
  }
  return best;
}

/** The highest tier among the earned badges, or null for none. */
export function highestTier(badges: readonly EarnedBadge[]): BadgeTier | null {
  return topBadge(badges)?.tier ?? null;
}

/** Someone's top badge, from the badge source. */
export function topBadgeFor(subject: BadgeSubject): ResolvedBadge | null {
  return topBadge(badgesFor(subject));
}

/** The mark's size for a picture of `avatar` px: about 40% of it, never under 9px or over 20px. */
export function tierMarkPx(avatar: number): number {
  return Math.round(Math.min(20, Math.max(9, avatar * 0.4)));
}

/**
 * The mark shows only on pictures at least as big as a chat message's
 * (32px); smaller ones, like reply avatars and member lists, leave it off
 * (owner review 2026-10-09).
 */
export const TIER_MARK_MIN_AVATAR = 32;
