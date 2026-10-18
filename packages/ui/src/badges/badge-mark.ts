/**
 * A badge mark's sizes and colours. The mark is drawn as SVG by
 * BadgeMark.svelte (owner pick 2026-10-15, option C "colour icon"): the
 * badge's Phosphor Duotone icon in the badge's own two colours, inside a
 * solid ring of the tier's colour.
 *
 * "micro" is 54px and "small" is 108px. In light mode the tiers use deeper
 * metals and the icon colours go through inkForLight, so the mark reads on a
 * light surface; a Legendary ring uses the HQ gradient, tuned per theme, and
 * a locked mark is grey, ring and icon alike.
 */

import { HQ_GRADIENT, TIER_RING, type BadgeIcon, type BadgeTier } from "./badge-catalog.js";
import { inkForLight, type BadgeTheme } from "./badge-theme.js";

export type BadgeMarkSize = "micro" | "small";

export const BADGE_FONT = '"Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace';

/** Tier metals deep enough to read on a light surface. */
export const TIER_RING_LIGHT: Readonly<Record<1 | 2 | 3, string>> = { 1: "#8a4522", 2: "#4f566b", 3: "#8f6400" };

/** A locked mark's grey, ring and icon alike. */
export const LOCKED_MARK: Readonly<Record<BadgeTheme, string>> = { dark: "#6f6878", light: "#958e9f" };

/** The opacity of the icon's Duotone tint: a touch more on dark, where it has no white behind it. */
export const MARK_TINT_OPACITY: Readonly<Record<BadgeTheme, number>> = { dark: 0.4, light: 0.3 };

/**
 * Each badge icon's own two colours: `line` for the icon's line, `tint` for
 * its Duotone tint. These are the badge's own colours from the ASCII Color
 * art, so the marks match the holographic cards (owner pick 2026-10-15,
 * option C): most are the old micro icons' c and a; the ten for flag,
 * house, toolbox, bulb, people, robot, plug, clipboard, crown and pulse
 * were retuned from the full-size art (owner review 2026-10-15).
 */
export const BADGE_ICON_COLOR: Readonly<Record<BadgeIcon, { line: string; tint: string }>> = {
  flag: { line: "#ff6f91", tint: "#ff6f91" },
  house: { line: "#e8735a", tint: "#f0c08a" },
  bug: { line: "#e8566f", tint: "#e8566f" },
  rocket: { line: "#ebe7f6", tint: "#8fd6ff" },
  bolt: { line: "#ffd23f", tint: "#ffd23f" },
  toolbox: { line: "#e8566f", tint: "#ff9f45" },
  bulb: { line: "#f0a830", tint: "#ffe066" },
  people: { line: "#5fd3c0", tint: "#5fd3c0" },
  robot: { line: "#5fd3c0", tint: "#5fd3c0" },
  plug: { line: "#7cc8ff", tint: "#7cc8ff" },
  plane: { line: "#e6e8f2", tint: "#8fc7ff" },
  calendar: { line: "#f0f0f6", tint: "#e8566f" },
  box: { line: "#e3a36e", tint: "#f7d35c" },
  clipboard: { line: "#c98a52", tint: "#f0d2a8" },
  flame: { line: "#ff9f45", tint: "#ffe27a" },
  crown: { line: "#f0a830", tint: "#ffd23f" },
  wheel: { line: "#e3a96b", tint: "#ffd23f" },
  pulse: { line: "#ff6f91", tint: "#ff6f91" },
  code: { line: "#8fc7ff", tint: "#ffd23f" },
  rat: { line: "#c9b6a8", tint: "#f2a6b8" },
};

/** CSS pixel size of a mark. */
export function badgeMarkPx(size: BadgeMarkSize): number {
  return size === "micro" ? 54 : 108;
}

function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const A = p(a);
  const B = p(b);
  return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** The HQ gradient as the marks tune it: a touch darker on light, a touch warmer on dark. */
export function hqStops(theme: BadgeTheme): string[] {
  return HQ_GRADIENT.map((c) => (theme === "light" ? mix(c, "#1c1036", 0.1) : mix(c, "#fff4dc", 0.15)));
}

/** A mark's ring colour, or null for Legendary, whose ring uses the HQ gradient. */
export function markRingColor(tier: BadgeTier, locked: boolean, theme: BadgeTheme): string | null {
  if (locked) return LOCKED_MARK[theme];
  if (tier === "L") return null;
  return (theme === "light" ? TIER_RING_LIGHT : TIER_RING)[tier];
}

/**
 * The colours a mark's icon is drawn in: the badge's own line and tint,
 * deepened by inkForLight on light, at every tier (Legendary too). Grey when
 * locked.
 */
export function markIconColors(icon: BadgeIcon, theme: BadgeTheme, locked = false): { line: string; tint: string } {
  if (locked) return { line: LOCKED_MARK[theme], tint: LOCKED_MARK[theme] };
  const { line, tint } = BADGE_ICON_COLOR[icon];
  return theme === "light" ? { line: inkForLight(line), tint: inkForLight(tint) } : { line, tint };
}
