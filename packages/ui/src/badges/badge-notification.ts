/**
 * The badge behind a "badge_earned" notification. hq-pro's award job sends
 * `targetRef: "badge:<id>:<tier>"`; the app owns badge names and copy, so the
 * row's title and detail come from the catalog here, the same words as the
 * "You earned" notice (badge-announce.ts). Unknown badges and malformed refs
 * give null, and the row keeps the server's title as a plain row.
 */

import { BADGE_BY_ID, TIER_NAME, earnedTier, isAwarded, type ResolvedBadge } from "./badge-catalog.js";

export interface BadgeNotice {
  badge: ResolvedBadge;
  title: string;
  detail: string;
}

export function badgeFromTargetRef(targetRef: string | null | undefined, earnedAt = ""): ResolvedBadge | null {
  const match = /^badge:([a-z0-9-]+):(1|2|3|L)$/.exec((targetRef ?? "").trim());
  if (!match) return null;
  const def = BADGE_BY_ID[match[1]];
  if (!def) return null;
  // A single-level badge shows at its own tier whatever the server sends.
  const tier = earnedTier(def, match[2] === "L" ? "L" : Number(match[2]));
  return tier === null ? null : { def, tier, earnedAt };
}

export function badgeNotice(item: { targetRef: string | null; createdAt: string }): BadgeNotice | null {
  const badge = badgeFromTargetRef(item.targetRef, item.createdAt);
  if (!badge) return null;
  return {
    badge,
    title: isAwarded(badge.def) ? `You were awarded ${badge.def.name}` : `You earned ${badge.def.name}`,
    detail: `${TIER_NAME[badge.tier]} · ${badge.def.crit}.`,
  };
}
