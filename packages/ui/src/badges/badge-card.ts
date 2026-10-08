/**
 * The badge card: the collectible version of a badge (hq-accomplishment-badges,
 * "Color set" of the foil cards). Pure helpers for the card's words, its
 * number in the set, and how it tilts toward the pointer. Nothing here
 * touches the DOM, so the card component stays markup.
 *
 * Settled design (Lizzie, 2026-10-08): card #17161A in both app themes, the
 * full-colour ASCII badge, a frame in the tier colour, rainbow foil, corner
 * brackets only where the light is, no dots, a smooth fade under the text,
 * card text in Geist / Geist Mono.
 */

import { BADGES, TIER_NAME, type BadgeTier, type ResolvedBadge } from "./badge-catalog.js";

/** Card background, the same in the light and the dark app theme. */
export const CARD_BG = "#17161A";

/** The card's proportions: a trading card, 5 wide by 7 tall. */
export const CARD_ASPECT = 5 / 7;

/** The width the card's type and spacing were designed at; everything scales from it. */
export const CARD_BASIS_PX = 280;

const ROMAN: Readonly<Record<string, string>> = { 1: "I", 2: "II", 3: "III" };

/** "Tier II · Silver", or "Legendary". */
export function cardTierLabel(tier: BadgeTier): string {
  return tier === "L" ? TIER_NAME.L : `Tier ${ROMAN[tier]} · ${TIER_NAME[tier]}`;
}

/** The badge's place in the set: "No. 004 / 016". */
export function cardNumber(id: string): string {
  const at = BADGES.findIndex((b) => b.id === id);
  const pad = (n: number) => String(n).padStart(3, "0");
  return at < 0 ? "" : `No. ${pad(at + 1)} / ${pad(BADGES.length)}`;
}

/** "Oct 6, 2026", or the raw value when it is not a date. */
export function cardDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** What a screen reader hears for the card: name, tier, what earns it, when. */
export function cardAccessibleLabel(badge: ResolvedBadge): string {
  return `${badge.def.name} card, ${TIER_NAME[badge.tier]}. ${badge.def.crit}. Earned ${cardDate(badge.earnedAt)}.`;
}

/** Reveal timing (ms): the glow comes up, then the card turns over from its back to its face. */
export const REVEAL_GLOW_MS = 450;
export const REVEAL_FLIP_MS = 1000;

/** How far the pointer is from the card's centre, -1..1 on each axis, and how near it is (0..1). */
export interface PointerOnCard {
  x: number;
  y: number;
  near: number;
}

/**
 * Where the pointer is relative to the card. `near` is 1 over the card and
 * eases to 0 across `approach` pixels outside it, so the light and the tilt
 * build up as the pointer arrives instead of snapping on.
 */
export function pointerOnCard(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  approach = 48,
): PointerOnCard {
  const w = rect.width / 2 || 1;
  const h = rect.height / 2 || 1;
  const cx = rect.left + w;
  const cy = rect.top + h;
  const ox = Math.max(0, Math.abs(clientX - cx) - w);
  const oy = Math.max(0, Math.abs(clientY - cy) - h);
  const t = Math.max(0, 1 - Math.hypot(ox, oy) / Math.max(1, approach));
  return { x: (clientX - cx) / w, y: (clientY - cy) / h, near: t * t * (3 - 2 * t) };
}

/** The card's tilt in radians toward the pointer: up to 0.16 sideways and 0.12 up or down. */
export function cardTilt(p: PointerOnCard): { x: number; y: number } {
  const cl = (v: number) => Math.max(-1, Math.min(1, v));
  return { x: cl(p.x) * 0.16 * p.near, y: -cl(p.y) * 0.12 * p.near };
}

/** The tilt as a CSS transform, with a perspective of 3.5 card widths (the foil's camera). */
export function cardTransform(tilt: { x: number; y: number }, width: number): string {
  const persp = Math.round(Math.max(1, width) * 3.5);
  return `perspective(${persp}px) rotateX(${tilt.y.toFixed(4)}rad) rotateY(${tilt.x.toFixed(4)}rad)`;
}

/** Whether the person asked for less motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
