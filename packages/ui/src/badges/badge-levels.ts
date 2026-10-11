import { TIER_NAME, type BadgeDef, type BadgeTier } from "./badge-catalog.js";

export interface BadgeLevel {
  tier: string;
  label: string;
  reached: boolean;
  current: boolean;
}

const RANK: Record<string, number> = { 1: 0, 2: 1, 3: 2, L: 3 };

/** The tier of each level in order: Bronze, Silver, Gold, then Legendary for a fourth. */
const LEVEL_TIERS: readonly BadgeTier[] = [1, 2, 3, "L"];

/**
 * The levels of a badge, from its "1 · 10 · 50 deploys" description, with the
 * one reached marked. A bare number takes the unit of the last level. A badge
 * with a fourth level ("1 · 10 · 100 · 500 PRs") has Legendary as its top.
 * Single-level and limited badges have one row at the badge's own tier.
 */
export function badgeLevels(def: BadgeDef, tier: BadgeTier): BadgeLevel[] {
  const parts = def.levels.split(" · ").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) {
    return [{ tier: TIER_NAME[tier], label: def.levels, reached: true, current: true }];
  }
  const unit = /^[\d,]+\s+(.+)$/.exec(parts[parts.length - 1])?.[1] ?? "";
  const reachedRank = RANK[String(tier)] ?? 0;
  const shown = parts.slice(0, LEVEL_TIERS.length);
  return shown.map((part, i) => ({
    tier: TIER_NAME[LEVEL_TIERS[i]],
    label: unit && /^[\d,]+$/.test(part) ? `${part} ${part === "1" ? unit.replace(/s$/, "") : unit}` : part,
    reached: i <= reachedRank,
    current: i === Math.min(reachedRank, shown.length - 1),
  }));
}
