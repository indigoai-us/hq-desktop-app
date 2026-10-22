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
 * (lightest), and the bar keeps its hairline between parts.
 *
 * Every level has a light palette (the top-level fields) and a dark one
 * (`dark`), so every part, and both stops of every gradient, is at least 3:1
 * against the surface the bar is drawn on (WCAG 1.4.11): #ffffff and #fafafa
 * in light, #242424 and #2a2a2a in dark. One palette cannot do both and keep
 * the groups apart. usage-level-theme.test.ts measures it. No palette uses
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
  /** CSS background per group id in light; "other" falls back to the storage colour. */
  agents: string;
  sync: string;
  storage: string;
  /** The same parts in dark. */
  dark: { agents: string; sync: string; storage: string };
  /** The level mark (coin) colours: ring/fill and the number on it. */
  mark: string;
  markInk: string;
}

const grad = (a: string, b: string) => `linear-gradient(90deg, ${a}, ${b})`;

export const LEVEL_THEMES: readonly LevelTheme[] = [
  // 1 Sketch: sky.
  {
    level: 1,
    finish: "flat",
    agents: "#014f78",
    sync: "#066f9e",
    storage: "#0d8ec9",
    dark: { agents: "#027fc0", sync: "#08a2e7", storage: "#63c7f5" },
    mark: "#0369a1",
    markInk: "#ffffff",
  },
  // 2 Prototype: emerald.
  {
    level: 2,
    finish: "flat",
    agents: "#03553e",
    sync: "#0a7753",
    storage: "#29966d",
    dark: { agents: "#058964", sync: "#0faf7a", storage: "#55d1a2" },
    mark: "#059669",
    markInk: "#ffffff",
  },
  // 3 Launch: indigo.
  {
    level: 3,
    finish: "flat",
    agents: "#3d32be",
    sync: "#4a55ec",
    storage: "#6b78f8",
    dark: { agents: "#736bd7", sync: "#8990f3", storage: "#afb7fb" },
    mark: "#4f46e5",
    markInk: "#ffffff",
  },
  // 4 Scale: fuchsia.
  {
    level: 4,
    finish: "flat",
    agents: "#80168a",
    sync: "#b211c9",
    storage: "#d92df7",
    dark: { agents: "#cb23db", sync: "#e068f2", storage: "#ee9efc" },
    mark: "#c026d3",
    markInk: "#ffffff",
  },
  // 5 Engine: cyan to blue gradients.
  {
    level: 5,
    finish: "gradient",
    agents: grad("#044655", "#143697"),
    sync: grad("#0a7484", "#0b5ee8"),
    storage: grad("#0699ab", "#288bfb"),
    dark: { agents: grad("#0783a1", "#4872e6"), sync: grad("#0fa9c0", "#6099f8"), storage: grad("#08cfe5", "#89c0fd") },
    mark: grad("#0e7490", "#1d4ed8"),
    markInk: "#ffffff",
  },
  // 6 Flagship: violet to rose gradients, sheen on unlock and hover.
  {
    level: 6,
    finish: "sheen",
    agents: grad("#5d21ba", "#921248"),
    sync: grad("#9027f5", "#c9156e"),
    storage: grad("#ab5dfd", "#f1349a"),
    dark: { agents: grad("#905be2", "#e42574"), sync: grad("#bc7df9", "#f06aac"), storage: grad("#d3aafe", "#f8a0d0") },
    mark: grad("#7c3aed", "#db2777"),
    markInk: "#ffffff",
  },
  // 7 Landmark: the violet-to-rose run of the HQ brand gradient (its coral and
  // peach ends read as the limit colours on a bar), split across the groups,
  // sheen on unlock and hover. The coin keeps the full brand gradient.
  {
    level: 7,
    finish: "sheen",
    agents: grad("#3d23d5", "#5726bb"),
    sync: grad("#923bd3", "#ac3997"),
    storage: grad("#c95cb5", "#e84d6a"),
    dark: { agents: grad("#7865e6", "#8960df"), sync: grad("#ba83e3", "#d37cc3"), storage: grad("#e3aad8", "#f3a7b5") },
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
export function levelSegmentColor(id: string, level: number, tone: StackTone = "ok", scheme: "light" | "dark" = "light"): string {
  const theme = levelTheme(level);
  if (!theme || tone !== "ok" || id === "trial") return segmentColor(id);
  const parts = scheme === "dark" ? theme.dark : theme;
  switch (id) {
    case "agents":
      return parts.agents;
    case "sync":
      return parts.sync;
    default:
      return parts.storage;
  }
}

/**
 * Inline custom properties for a bar part or legend dot: `--{name}` (light)
 * and `--{name}-dark`. The element's CSS draws `var(--{name})` and switches to
 * `var(--{name}-dark)` under prefers-color-scheme: dark.
 */
export function levelSegmentVars(name: string, id: string, level: number, tone: StackTone = "ok"): string {
  return `--${name}:${levelSegmentColor(id, level, tone, "light")};--${name}-dark:${levelSegmentColor(id, level, tone, "dark")};`;
}

/** Whether the bar may run the sheen at this level and tone (motion preference is checked by the caller). */
export function levelHasSheen(level: number, tone: StackTone): boolean {
  return levelPaletteActive(level, tone) && levelTheme(level)?.finish === "sheen";
}
