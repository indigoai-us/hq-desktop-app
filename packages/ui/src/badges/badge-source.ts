/**
 * Where profile panes get a person's or bot's earned badges.
 *
 * There is no badges API yet, so production returns none and the Badges
 * section stays hidden. The design harness installs a sample source.
 */

import type { EarnedBadge } from "./badge-catalog.js";

export interface BadgeSubject {
  kind: "person" | "bot";
  name: string;
  email?: string | null;
}

export type BadgeSource = (subject: BadgeSubject) => readonly EarnedBadge[];

const none: BadgeSource = () => [];
let source: BadgeSource = none;

export function setBadgeSource(next: BadgeSource | null): void {
  source = next ?? none;
}

export function badgesFor(subject: BadgeSubject): readonly EarnedBadge[] {
  if (!subject.name.trim()) return [];
  try {
    return source(subject);
  } catch {
    return [];
  }
}

/**
 * How far someone is toward a badge they have not earned yet: "3 of 5
 * skills". Like earned badges there is no API yet, so production returns
 * none and locked badges show only what earns them.
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
  if (!subject.name.trim()) return [];
  try {
    return progressSource(subject);
  } catch {
    return [];
  }
}
