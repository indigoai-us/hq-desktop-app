/**
 * hq-accomplishment-badges US-016: the launch announcement.
 *
 * On launch day the app introduces accomplishments once, over the whole
 * window, with the badges the person already has (BadgeLaunchAnnouncement).
 * This file decides when it shows and lays out the hand of cards.
 *
 * It shows only when the badge source says badges are on for the signed-in
 * person (hq-pro's `badges.api` answers `enabled: true`), so turning the flag
 * on for everyone on launch day is what turns the announcement on. A person
 * the flag leaves out, or whose badges have not loaded, never sees it.
 *
 * It shows once per person per device: closing it, "Not now" and "See your
 * badges" all record it as seen, keyed by the person's uid, so a second
 * account on the same machine still gets its own.
 */

import type { BadgeProgress } from "./badge-source.js";
import type { BadgeTier, ResolvedBadge } from "./badge-catalog.js";

/** Bumping this shows the announcement again to everyone; keep it for the launch. */
export const LAUNCH_ANNOUNCEMENT_ID = "accomplishments-2026-10";

/** How many cards the hand shows; the rest are counted ("+3 more"). */
export const LAUNCH_HAND_MAX = 5;

/** The wait after badges load before it opens, so the shell has settled. */
export const LAUNCH_OPEN_DELAY_MS = 1200;

export type LaunchStorage = Pick<Storage, "getItem" | "setItem">;

export function launchSeenKey(uid: string): string {
  return `hq.badges.launch.${LAUNCH_ANNOUNCEMENT_ID}.seen.${uid}`;
}

function defaultStorage(): LaunchStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Whether this person has seen the announcement on this device. With no
 * storage at all it counts as seen: an announcement that cannot remember it
 * was closed would come back on every launch.
 */
export function hasSeenLaunch(uid: string, storage: LaunchStorage | null = defaultStorage()): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(launchSeenKey(uid)) !== null;
  } catch {
    return true;
  }
}

export function markLaunchSeen(uid: string, storage: LaunchStorage | null = defaultStorage(), at: Date = new Date()): void {
  try {
    storage?.setItem(launchSeenKey(uid), at.toISOString());
  } catch {
    // Storage full or blocked: it may show once more. Nothing to tell the person.
  }
}

export interface LaunchGate {
  /** The signed-in person's uid (`prs_*`), if known. */
  uid: string | null | undefined;
  /** The badge source's answer for them: true, false, or null while loading. */
  enabled: boolean | null;
  seen: boolean;
  /** Another takeover owns the window (first-run setup, the guided tour). */
  busy: boolean;
}

export function shouldShowLaunch(gate: LaunchGate): boolean {
  const uid = gate.uid?.trim();
  return Boolean(uid) && /^prs_/.test(uid!) && gate.enabled === true && !gate.seen && !gate.busy;
}

const TIER_RANK: Readonly<Record<string, number>> = { L: 4, 3: 3, 2: 2, 1: 1 };

/**
 * The cards in the hand: highest tier first, newest first within a tier, so
 * the best card sits in the middle of the fan. At most {@link LAUNCH_HAND_MAX}.
 */
export function launchHand(badges: readonly ResolvedBadge[]): { shown: ResolvedBadge[]; more: number } {
  const ordered = [...badges].sort((a, b) => {
    const t = (TIER_RANK[String(b.tier)] ?? 0) - (TIER_RANK[String(a.tier)] ?? 0);
    if (t !== 0) return t;
    return a.earnedAt < b.earnedAt ? 1 : a.earnedAt > b.earnedAt ? -1 : 0;
  });
  const shown = ordered.slice(0, LAUNCH_HAND_MAX);
  // Best in the middle: 4 2 0 1 3 for five cards.
  const fanned: ResolvedBadge[] = [];
  shown.forEach((badge, i) => (i % 2 === 0 ? fanned.push(badge) : fanned.unshift(badge)));
  return { shown: fanned, more: Math.max(0, badges.length - shown.length) };
}

export interface FanSlot {
  /** Horizontal offset in card widths from the middle. */
  x: number;
  /** Drop in card heights: the outer cards sit lower, on an arc. */
  y: number;
  /** Rotation in degrees. */
  rotate: number;
  /** Stacking: the middle card on top. */
  z: number;
}

/** Where each of `count` cards sits in the fan. */
export function fanSlots(count: number): FanSlot[] {
  const mid = (count - 1) / 2;
  // Fewer cards spread wider apart, so two cards do not look like a mistake.
  const spread = count <= 2 ? 0.72 : count === 3 ? 0.66 : 0.6;
  const turn = count <= 2 ? 6 : 7;
  return Array.from({ length: count }, (_, i) => {
    const off = i - mid;
    return { x: off * spread, y: off * off * 0.035, rotate: off * turn, z: 10 - Math.round(Math.abs(off) * 2) };
  });
}

/** The highest tier in the hand, for the light behind it. */
export function handTier(badges: readonly ResolvedBadge[]): BadgeTier | null {
  let best: BadgeTier | null = null;
  for (const b of badges) if (best === null || (TIER_RANK[String(b.tier)] ?? 0) > (TIER_RANK[String(best)] ?? 0)) best = b.tier;
  return best;
}

/** For someone with no badges yet: the ones they are closest to, nearest first. */
export function nextUp(progress: readonly BadgeProgress[], limit = 3): BadgeProgress[] {
  return [...progress]
    .filter((p) => p.target > 0 && p.current < p.target)
    .sort((a, b) => b.current / b.target - a.current / a.target)
    .slice(0, limit);
}

/** "3 of 5 skills", "0 of 1 project". */
export function progressLine(p: BadgeProgress): string {
  const unit = p.target === 1 ? p.unit.replace(/s$/, "") : p.unit;
  return `${p.current.toLocaleString("en-US")} of ${p.target.toLocaleString("en-US")} ${unit}`;
}

/** The line under the title. */
export function launchLead(count: number): string {
  if (count === 0) return "Badges for the work you do in HQ. Your first ones are close.";
  return count === 1
    ? "Badges for the work you do in HQ. You already have one."
    : `Badges for the work you do in HQ. You already have ${count}.`;
}

let preview = false;

/**
 * Design harness only (`?launch` on the shell view): show the announcement
 * whatever the gate says, once, without recording it as seen.
 */
export function setLaunchPreview(on: boolean): void {
  preview = on;
}

export function launchPreview(): boolean {
  return preview;
}
