/**
 * HQ accomplishment badges: the catalog, tiers and tier colours.
 *
 * Design source: the "ASCII Color" direction in the hq-accomplishment-badges
 * project (Indigo). Colour here is an approved exception to the achromatic
 * console-rail standard: tier rings and icon colours carry meaning.
 *
 * Pure data. Nothing here touches the DOM.
 */

export type BadgeTier = 1 | 2 | 3 | "L";

export type BadgeIcon =
  | "flag" | "house" | "bug" | "rocket" | "bolt" | "toolbox" | "bulb" | "people"
  | "robot" | "plug" | "plane" | "calendar" | "box" | "clipboard" | "flame"
  | "crown" | "wheel" | "pulse" | "code";

/** "honors": given to the people who built and lead HQ, not earned by use. */
export type BadgeFamily = "early" | "usage" | "honors";

export interface BadgeDef {
  id: string;
  name: string;
  icon: BadgeIcon;
  family: BadgeFamily;
  /** What earns it, as one plain sentence fragment. */
  crit: string;
  /** The three or four levels (a fourth is Legendary), or why there is only one. */
  levels: string;
  /** Tier the badge is shown at when no earned level is known. */
  tier: BadgeTier;
}

export const BADGES: readonly BadgeDef[] = [
  { id: "founding", name: "Founding Member", icon: "flag", family: "early", crit: "Joined HQ before the public launch", levels: "Limited, never earnable again", tier: 3 },
  { id: "founder", name: "Founder", icon: "house", family: "early", crit: "Started a company in HQ that a teammate joined", levels: "Single level", tier: 3 },
  { id: "bughunter", name: "Bug Hunter", icon: "bug", family: "early", crit: "Sent feedback that helps improve HQ", levels: "3 · 10 · 25 reports", tier: 2 },
  { id: "liftoff", name: "Liftoff", icon: "rocket", family: "usage", crit: "Deploys that went live", levels: "5 · 50 · 250 deploys", tier: 1 },
  { id: "poweruser", name: "Power User", icon: "bolt", family: "usage", crit: "Skills run", levels: "100 · 500 · 2,500 runs", tier: 3 },
  { id: "toolbox", name: "Toolbox", icon: "toolbox", family: "usage", crit: "Different skills used", levels: "5 · 15 · 40 skills", tier: 2 },
  { id: "maker", name: "Maker", icon: "bulb", family: "usage", crit: "Skills you wrote", levels: "5 · 50 · 250 skills", tier: 1 },
  { id: "teambuilder", name: "Team Builder", icon: "people", family: "usage", crit: "Teammates who accepted your invite", levels: "3 · 10 · 25 invites", tier: 2 },
  { id: "fleet", name: "Fleet Commander", icon: "robot", family: "usage", crit: "Agents you created", levels: "1 · 5 · 15 agents", tier: 3 },
  { id: "connector", name: "Connector", icon: "plug", family: "usage", crit: "Apps connected to HQ", levels: "3 · 6 · 10 apps", tier: 1 },
  { id: "sharer", name: "Sharer", icon: "plane", family: "usage", crit: "Files shared with teammates", levels: "1 · 10 · 50 files", tier: 2 },
  { id: "regular", name: "Regular", icon: "calendar", family: "usage", crit: "Kept coming back to HQ", levels: "Week 2 · Month 1 · Month 6", tier: 3 },
  { id: "shipit", name: "Ship It", icon: "box", family: "usage", crit: "Projects shipped", levels: "1 · 5 · 20 projects", tier: 1 },
  { id: "closer", name: "Closer", icon: "clipboard", family: "usage", crit: "Stories completed", levels: "10 · 100 · 500 stories", tier: 2 },
  { id: "onfire", name: "On Fire", icon: "flame", family: "usage", crit: "Days in a row using HQ", levels: "7 · 30 · 100 days", tier: 1 },
  { id: "og", name: "OG", icon: "crown", family: "honors", crit: "On the team that built HQ from day one", levels: "Single level", tier: "L" },
  { id: "captain", name: "Captain", icon: "wheel", family: "honors", crit: "Leads HQ", levels: "Single level", tier: "L" },
  { id: "patientzero", name: "Patient Zero", icon: "pulse", family: "honors", crit: "The first person to run HQ", levels: "Single level", tier: "L" },
  { id: "corebuilder", name: "Core Builder", icon: "code", family: "honors", crit: "Pull requests merged into HQ core", levels: "1 · 10 · 100 · 200 PRs", tier: 1 },
];

export const BADGE_BY_ID: Readonly<Record<string, BadgeDef>> = Object.fromEntries(BADGES.map((b) => [b.id, b]));

/**
 * The tiers a badge can be earned at: Bronze to Gold for a badge with three
 * levels, Legendary too for one with a fourth (Core Builder), and only its
 * own tier for a single-level or limited badge.
 */
export function earnableTiers(def: BadgeDef): BadgeTier[] {
  const levels = def.levels.split(" · ").length;
  return levels >= 4 ? [1, 2, 3, "L"] : levels >= 3 ? [1, 2, 3] : [def.tier];
}

/**
 * The tier a badge shows at when `tier` is asked for. A single-level badge is
 * at its own tier whatever is asked; any other needs a tier it can be earned
 * at, else null. The loader reads hq-pro's badges by this, and the design
 * harness its `?earn=` switch.
 */
export function earnedTier(def: BadgeDef, tier: unknown): BadgeTier | null {
  const tiers = earnableTiers(def);
  if (tiers.length === 1) return tiers[0];
  return tiers.find((t) => t === tier) ?? null;
}

/**
 * OG, Captain and Patient Zero are given to people, not earned by use, so
 * they say "Awarded" where other badges say "Earned". Core Builder is an
 * honor too, but merging pull requests earns it (owner review 2026-10-12).
 */
export function isAwarded(def: BadgeDef): boolean {
  return def.family === "honors" && earnableTiers(def).length === 1;
}

export const TIER_NAME: Readonly<Record<string, string>> = { 1: "Bronze", 2: "Silver", 3: "Gold", L: "Legendary" };

/** Ring colour per metal tier; Legendary uses the HQ gradient instead. */
export const TIER_RING: Readonly<Record<1 | 2 | 3, string>> = { 1: "#c7804f", 2: "#aab0c6", 3: "#e3ad2c" };

/** HQ brand gradient: indigo → violet → pink → coral → peach. */
export const HQ_GRADIENT = ["#3b22d0", "#6a35d6", "#9a4ad6", "#c95cb5", "#ec6f86", "#f6806a", "#fca58a"] as const;

/** A badge someone has earned. `tier` is the level reached; it defaults to the badge's display tier. */
export interface EarnedBadge {
  id: string;
  tier?: BadgeTier;
  /** ISO date. Newest first in every list. */
  earnedAt: string;
}

export interface ResolvedBadge {
  def: BadgeDef;
  tier: BadgeTier;
  earnedAt: string;
}

/** Earned badges with their definitions, newest first; unknown ids are dropped. */
export function resolveEarned(earned: readonly EarnedBadge[]): ResolvedBadge[] {
  return earned
    .filter((e) => BADGE_BY_ID[e.id])
    .map((e) => ({ def: BADGE_BY_ID[e.id], tier: e.tier ?? BADGE_BY_ID[e.id].tier, earnedAt: e.earnedAt }))
    .sort((x, y) => (x.earnedAt < y.earnedAt ? 1 : x.earnedAt > y.earnedAt ? -1 : 0));
}
