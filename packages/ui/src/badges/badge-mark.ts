/**
 * A badge mark's sizes and colours. The mark is drawn as SVG by
 * BadgeMark.svelte (owner pick 2026-10-15, option B): the badge's Phosphor
 * Duotone icon in a solid ring, ring and icon in one colour per tier.
 *
 * "micro" is 54px and "small" is 108px. In light mode the tiers use deeper
 * metals so the mark reads on a light surface; Legendary uses the HQ
 * gradient, tuned per theme, and a locked mark is grey.
 */

import { HQ_GRADIENT, TIER_RING, type BadgeTier } from "./badge-catalog.js";
import type { BadgeTheme } from "./badge-theme.js";

export type BadgeMarkSize = "micro" | "small";

export const BADGE_FONT = '"Geist Mono Variable", "Geist Mono", ui-monospace, Menlo, monospace';

/** Tier metals deep enough to read on a light surface. */
export const TIER_RING_LIGHT: Readonly<Record<1 | 2 | 3, string>> = { 1: "#8a4522", 2: "#4f566b", 3: "#8f6400" };

/** A locked mark's grey, ring and icon alike. */
export const LOCKED_MARK: Readonly<Record<BadgeTheme, string>> = { dark: "#6f6878", light: "#958e9f" };

/** The opacity of the icon's Duotone tint: a touch more on dark, where it has no white behind it. */
export const MARK_TINT_OPACITY: Readonly<Record<BadgeTheme, number>> = { dark: 0.22, light: 0.16 };

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

/** The one colour a mark's ring and icon share, or null for Legendary, which uses the HQ gradient. */
export function markColor(tier: BadgeTier, locked: boolean, theme: BadgeTheme): string | null {
  if (locked) return LOCKED_MARK[theme];
  if (tier === "L") return null;
  return (theme === "light" ? TIER_RING_LIGHT : TIER_RING)[tier];
}
