/**
 * HQ accomplishment badges: the catalog and the ASCII art for the small marks.
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
  | "robot" | "plug" | "plane" | "calendar" | "box" | "clipboard" | "flame" | "sprout";

export type BadgeFamily = "early" | "usage" | "training";

export interface BadgeDef {
  id: string;
  name: string;
  icon: BadgeIcon;
  family: BadgeFamily;
  /** What earns it, as one plain sentence fragment. */
  crit: string;
  /** The three levels, or why there is only one. */
  levels: string;
  /** Tier the badge is shown at when no earned level is known. */
  tier: BadgeTier;
}

export const BADGES: readonly BadgeDef[] = [
  { id: "founding", name: "Founding Member", icon: "flag", family: "early", crit: "Joined HQ before the public launch", levels: "Limited, never earnable again", tier: "L" },
  { id: "founder", name: "Founder", icon: "house", family: "early", crit: "Created a company in HQ", levels: "Single level", tier: 3 },
  { id: "bughunter", name: "Bug Hunter", icon: "bug", family: "early", crit: "Sent feedback that helps improve HQ", levels: "1 · 5 · 20 reports", tier: 2 },
  { id: "liftoff", name: "Liftoff", icon: "rocket", family: "usage", crit: "Deploys that went live", levels: "1 · 10 · 50 deploys", tier: 1 },
  { id: "poweruser", name: "Power User", icon: "bolt", family: "usage", crit: "Skills run", levels: "100 · 1,000 · 10,000 runs", tier: 3 },
  { id: "toolbox", name: "Toolbox", icon: "toolbox", family: "usage", crit: "Different skills used", levels: "5 · 15 · 40 skills", tier: 2 },
  { id: "maker", name: "Maker", icon: "bulb", family: "usage", crit: "Wrote your own skill, policy or knowledge", levels: "1 · 2 · all 3 kinds", tier: 1 },
  { id: "teambuilder", name: "Team Builder", icon: "people", family: "usage", crit: "Teammates who accepted your invite", levels: "1 · 5 · 20 invites", tier: 2 },
  { id: "fleet", name: "Fleet Commander", icon: "robot", family: "usage", crit: "Agents created and put to work", levels: "1 agent · 100 · 1,000 runs", tier: 3 },
  { id: "connector", name: "Connector", icon: "plug", family: "usage", crit: "Apps connected to HQ", levels: "1 · 3 · 6 apps", tier: 1 },
  { id: "sharer", name: "Sharer", icon: "plane", family: "usage", crit: "Files shared with teammates", levels: "1 · 10 · 50 files", tier: 2 },
  { id: "regular", name: "Regular", icon: "calendar", family: "usage", crit: "Kept coming back to HQ", levels: "Week 2 · Month 1 · Month 6", tier: 3 },
  { id: "shipit", name: "Ship It", icon: "box", family: "usage", crit: "Projects shipped", levels: "1 · 5 · 20 projects", tier: 1 },
  { id: "closer", name: "Closer", icon: "clipboard", family: "usage", crit: "Stories completed", levels: "10 · 100 · 500 stories", tier: 2 },
  { id: "onfire", name: "On Fire", icon: "flame", family: "usage", crit: "Days in a row using HQ", levels: "7 · 30 · 100 days", tier: 1 },
  { id: "signedup", name: "Signed Up", icon: "sprout", family: "training", crit: "Registered for an HQ workshop", levels: "Single level", tier: 1 },
];

export const BADGE_BY_ID: Readonly<Record<string, BadgeDef>> = Object.fromEntries(BADGES.map((b) => [b.id, b]));

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

export interface AsciiIcon {
  /** Main colour. */
  c: string;
  /** Accent colour, for the characters in `acc`. */
  a: string;
  acc: string;
  art: readonly string[];
  /** Join stacked `|` into one stroke (the glyph is shorter than the row). */
  join?: boolean;
}

/** Small version (108px): a solid ring plus a hand-made ASCII icon. */
export const SMALL_ICONS: Readonly<Record<BadgeIcon, AsciiIcon>> = {
  flag: { c: "#f07a92", a: "#c7c9d6", acc: "|", join: true, art: ["|####", "|####", "|####", "|", "|"] },
  house: { c: "#e8a35a", a: "#7fd0ff", acc: "[]#", art: ["   /\\", "  /  \\", " /____\\", " |[]|#|"] },
  bug: { c: "#e8566f", a: "#2a2238", acc: "|", art: ["  \\_/", "-(#|#)-", "-(#|#)-", " /   \\"] },
  rocket: { c: "#ebe7f6", a: "#8fd6ff", acc: "()", art: ["  /\\", " |  |", " |()|", "/|  |\\", " /\\/\\"] },
  bolt: { c: "#ffd23f", a: "#fff3b0", acc: "", art: ["    ____", "   /   /_", "  /__   /", "    / /", "   //"] },
  toolbox: { c: "#e8566f", a: "#c7c9d6", acc: "o.", art: ["  .---.", ".-+---+-.", "|   o   |", "'-------'"] },
  bulb: { c: "#ffd23f", a: "#c7c9d6", acc: "=-'", art: [" .-.", "( * )", " \\ /", " |=|", " '-'"] },
  people: { c: "#8fd6a0", a: "#b9a7ff", acc: "", art: [" o   o", "/|\\ /|\\", "/ \\ / \\"] },
  robot: { c: "#c7c9d6", a: "#5ee0c0", acc: "o", art: ["  _|_", " [o o]", " [_=_]", " _| |_"] },
  plug: { c: "#8fc7ff", a: "#c7c9d6", acc: "|", art: [" | |", "[===]", "[   ]", " \\_/", "  |"] },
  plane: { c: "#e6e8f2", a: "#8fc7ff", acc: "+", art: ["   |", "---+---", "   |", "  -+-"] },
  calendar: { c: "#f0f0f6", a: "#e8566f", acc: "\"=", art: [" \"   \"", ".=====.", "|# # #|", "|# # #|", "'-----'"] },
  box: { c: "#e3a36e", a: "#f7d35c", acc: "=", art: [" ____", "/___/|", "|== ||", "|___|/"] },
  clipboard: { c: "#e3c9a6", a: "#8fd6a0", acc: "v", art: [" _[_]_", "|  v  |", "| --- |", "|_____|"] },
  flame: { c: "#ff9f45", a: "#ffe27a", acc: "_", art: ["  )", " ) \\", "/ ) (", "\\(_)/"] },
  sprout: { c: "#8fd6a0", a: "#c78a5a", acc: "\\_/", art: [" _   _", "(_\\ /_)", "   |", " \\___/"] },
};

/** Micro version (54px): only a 2–3 character icon stays legible. */
export const MICRO_ICONS: Readonly<Record<BadgeIcon, AsciiIcon>> = {
  flag: { c: "#f07a92", a: "#c7c9d6", acc: "|", art: ["|##", "|##", "|  "] },
  house: { c: "#e8a35a", a: "#7fd0ff", acc: "[]", art: ["/\\", "[]"] },
  bug: { c: "#e8566f", a: "#e8566f", acc: "", art: ["\\_/", "(#)", "/ \\"] },
  rocket: { c: "#ebe7f6", a: "#8fd6ff", acc: "o", art: [" ^ ", "|o|", "/ \\"] },
  bolt: { c: "#ffd23f", a: "#ffd23f", acc: "", art: [" /", "/_", " /"] },
  toolbox: { c: "#e8566f", a: "#c7c9d6", acc: "n", art: ["_n_", "[o]"] },
  bulb: { c: "#ffd23f", a: "#c7c9d6", acc: "=", art: ["(*)", " = "] },
  people: { c: "#8fd6a0", a: "#b9a7ff", acc: "", art: ["o o", "A A"] },
  robot: { c: "#c7c9d6", a: "#5ee0c0", acc: "o", art: ["[oo]", "_||_"] },
  plug: { c: "#8fc7ff", a: "#c7c9d6", acc: "|", art: ["| |", "[_]", " | "] },
  plane: { c: "#e6e8f2", a: "#8fc7ff", acc: "^", art: ["_|_", " | ", "-^-"] },
  calendar: { c: "#f0f0f6", a: "#e8566f", acc: "=", art: ["===", "|#|"] },
  box: { c: "#e3a36e", a: "#f7d35c", acc: "_", art: ["___", "|_|"] },
  clipboard: { c: "#e3c9a6", a: "#8fd6a0", acc: "v", art: ["|v|", "|_|"] },
  flame: { c: "#ff9f45", a: "#ffe27a", acc: "_", art: [" ( ", ")\\(", "(_)"] },
  sprout: { c: "#8fd6a0", a: "#c78a5a", acc: "_", art: ["\\|/", "_|_"] },
};

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
