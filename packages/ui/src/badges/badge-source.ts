/**
 * Where profile panes get a person's or bot's earned badges.
 *
 * Production installs the hq-pro loader (badge-loader.svelte.ts), which reads
 * `GET /v1/badges/{uid}` by person uid. With no source, or on any failure,
 * there are no badges and the Badges section stays hidden. The design
 * harness installs a sample source first, and the loader leaves it in place.
 */

import type { EarnedBadge } from "./badge-catalog.js";

export interface BadgeSubject {
  kind: "person" | "bot";
  name: string;
  email?: string | null;
  /**
   * The person's uid (`prs_*`). The hq-pro loader looks badges up by uid
   * only, so a subject without one has none in production. Left out for bots.
   */
  uid?: string | null;
}

export type BadgeSource = (subject: BadgeSubject) => readonly EarnedBadge[];

const none: BadgeSource = () => [];
let source: BadgeSource = none;

export function setBadgeSource(next: BadgeSource | null): void {
  source = next ?? none;
}

/** Whether a badge source is installed (the harness's samples, or the loader). */
export function hasBadgeSource(): boolean {
  return source !== none;
}

function named(subject: BadgeSubject): boolean {
  return Boolean(subject.name.trim() || subject.uid?.trim());
}

export function badgesFor(subject: BadgeSubject): readonly EarnedBadge[] {
  if (!named(subject)) return [];
  try {
    return source(subject);
  } catch {
    return [];
  }
}

/**
 * How far someone is toward a badge they have not earned yet: "3 of 5
 * skills". It comes with the earned badges from the same source; with none
 * installed, locked badges show only what earns them.
 */
export interface BadgeProgress {
  id: string;
  current: number;
  /** The count that earns the first level. */
  target: number;
  /** Plural unit, e.g. "skills"; singular is used when the target is 1. */
  unit: string;
}

export type BadgeProgressSource = (subject: BadgeSubject) => readonly BadgeProgress[];

const noProgress: BadgeProgressSource = () => [];
let progressSource: BadgeProgressSource = noProgress;

export function setBadgeProgressSource(next: BadgeProgressSource | null): void {
  progressSource = next ?? noProgress;
}

export function badgeProgressFor(subject: BadgeSubject): readonly BadgeProgress[] {
  if (!named(subject)) return [];
  try {
    return progressSource(subject);
  } catch {
    return [];
  }
}
