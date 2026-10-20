/**
 * Bar colours per company level (usage-only-pricing US-019). Each level gives
 * the account's usage bar its own palette, more special the higher it goes:
 *
 * - Levels 1 to 4: a flat palette in one hue (sky, emerald, indigo, fuchsia).
 * - Level 5: each part is a two-stop gradient (cyan to blue).
 * - Levels 6 and 7: gradients (violet to rose; the HQ brand gradient) with a
 *   sheen that crosses the bar once when the level unlocks and on hover, so
 *   the effect says "this level is new" and "this is your level". Reduced
 *   motion never runs it.
 *
 * The three groups stay apart at every level: each palette steps the
 * lightness from Agents and AI (deepest) through Sync to Storage and vaults
 * (lightest), and the bar keeps its hairline between parts. No palette uses
 * amber, orange or red, which belong to the limit states, and a limit state
 * (amber near a limit, red at it or paused) drops the level palette back to
 * the plain group colours so the warning is the only thing that stands out.
 *
 * Pure data and string helpers; no DOM.
 */

import { segmentColor, type StackTone } from "./usage-stack.js";
import { HQ_GRADIENT } from "../badges/badge-catalog.js";

export type LevelFinish = "flat" | "gradient" | "sheen";

export interface LevelTheme {
  level: number;
  finish: LevelFinish;
  /** CSS background per group id; "other" falls back to the storage colour. */
  agents: string;
  sync: string;
  storage: string;
  /** The level mark (coin) colours: ring/fill and the number on it. */
  mark: string;
  markInk: string;
}

const grad = (a: string, b: string) => `linear-gradient(90deg, ${a}, ${b})`;

export const LEVEL_THEMES: readonly LevelTheme[] = [
  // 1 Spark: sky.
  { level: 1, finish: "flat", agents: "#0284c7", sync: "#38bdf8", storage: "#93d8f8", mark: "#0369a1", markInk: "#ffffff" },
  // 2 Steady: emerald.
  { level: 2, finish: "flat", agents: "#047857", sync: "#10b981", storage: "#7fdcb9", mark: "#059669", markInk: "#ffffff" },
  // 3 Rising: indigo.
  { level: 3, finish: "flat", agents: "#4338ca", sync: "#6f78f0", storage: "#aab2fb", mark: "#4f46e5", markInk: "#ffffff" },
  // 4 Momentum: fuchsia.
  { level: 4, finish: "flat", agents: "#a21caf", sync: "#d946ef", storage: "#f0abfc", mark: "#c026d3", markInk: "#ffffff" },
  // 5 Powerhouse: cyan to blue gradients.
  {
    level: 5,
    finish: "gradient",
    agents: grad("#0891b2", "#1d4ed8"),
    sync: grad("#22d3ee", "#3b82f6"),
    storage: grad("#a5f3fc", "#93c5fd"),
    mark: grad("#0e7490", "#1d4ed8"),
    markInk: "#ffffff",
  },
  // 6 Summit: violet to rose gradients, sheen on unlock and hover.
  {
    level: 6,
    finish: "sheen",
    agents: grad("#6d28d9", "#be185d"),
    sync: grad("#a855f7", "#ec4899"),
    storage: grad("#d8b4fe", "#f9a8d4"),
    mark: grad("#7c3aed", "#db2777"),
    markInk: "#ffffff",
  },
  // 7 Legend: the HQ brand gradient, split across the groups, sheen on unlock and hover.
  {
    level: 7,
    finish: "sheen",
    agents: grad(HQ_GRADIENT[0], HQ_GRADIENT[2]),
    sync: grad(HQ_GRADIENT[3], HQ_GRADIENT[4]),
    storage: grad(HQ_GRADIENT[5], HQ_GRADIENT[6]),
    mark: `linear-gradient(135deg, ${HQ_GRADIENT[0]}, ${HQ_GRADIENT[2]} 40%, ${HQ_GRADIENT[4]} 75%, ${HQ_GRADIENT[6]})`,
    markInk: "#ffffff",
  },
];

export function levelTheme(level: number): LevelTheme | null {
  return LEVEL_THEMES.find((t) => t.level === level) ?? null;
}

/**
 * Whether the bar wears its level colours: a level is reached, and the bar is
 * calm. Near or at a limit the plain group colours come back.
 */
export function levelPaletteActive(level: number, tone: StackTone): boolean {
  return tone === "ok" && levelTheme(level) !== null;
}

/**
 * The background a bar part (or legend dot) draws with. With no level, or in
 * a limit state, it is the plain group colour (usage-stack.ts). The trial
 * total keeps its neutral ink at every level: it is one total, not a group.
 */
export function levelSegmentColor(id: string, level: number, tone: StackTone = "ok"): string {
  const theme = levelTheme(level);
  if (!theme || tone !== "ok" || id === "trial") return segmentColor(id);
  switch (id) {
    case "agents":
      return theme.agents;
    case "sync":
      return theme.sync;
    default:
      return theme.storage;
  }
}

/** Whether the bar may run the sheen at this level and tone (motion preference is checked by the caller). */
export function levelHasSheen(level: number, tone: StackTone): boolean {
  return levelPaletteActive(level, tone) && levelTheme(level)?.finish === "sheen";
}
