/**
 * Company levels, live (usage-only-pricing US-019): what each account's level
 * is right now, for the Core menu meter and Settings > Usage, and the one-time
 * accomplishment card when a level unlocks.
 *
 * Both surfaces call `observeUsageLevel` with each statement they read; the
 * record (usage-levels.ts) is folded, stored per signed-in person and
 * account, and the level is kept here so every surface paints the same one.
 * A card fires only when the record could be stored: a card that cannot
 * remember it was shown would come back on every read.
 */

import { registerAccountCache } from "../common/account-caches.js";
import {
  countsFromLines,
  loadLevelRecord,
  monthOf,
  observeMonth,
  saveLevelRecord,
  type LevelRecord,
  type LevelStorage,
} from "./usage-levels.js";
import { announceUsageLevel } from "./usage-level-announce.js";
import { dismissToast, toastItems } from "../shell/toast-stack.svelte.js";
import type { CoreUsageView } from "./core-usage-model.js";

export interface UsageLevelState {
  level: number;
  bestCents: number;
  bestMonth: string | null;
  /**
   * When the level unlocked in this session (ms), or null. The bar's sheen
   * plays once for each unlock (UsageStackBar remembers which it played).
   */
  freshAt: number | null;
  /** The signed-in person this state was folded for (null: no one yet, nothing stored). */
  viewer: string | null;
}

let viewer = $state<string | null>(null);
let states = $state<Record<string, UsageLevelState>>({});
let opener: ((accountKey: string) => void) | null = null;

function defaultStorage(): LevelStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The signed-in person (`prs_*`). Levels are stored and cards fire only with one. */
export function setUsageLevelViewer(uid: string | null | undefined): void {
  const next = uid?.trim() || null;
  if (next === viewer) return;
  const previous = viewer;
  viewer = next;
  // Levels read before anyone was known stay on screen (they hold no one's
  // record) and are folded with the person's stored record on the next read.
  // A change of person forgets the last person's levels and cards.
  if (previous !== null) {
    states = {};
    dismissLevelCards();
  }
}

/** Close any level-up card still on screen (sign-out, a change of person). */
function dismissLevelCards(): void {
  for (const t of toastItems()) if (t.key?.startsWith("usage-level:")) dismissToast(t.id);
}

/** What the card's "See usage" does: open Settings > Usage on that account. */
export function setUsageLevelOpener(fn: ((accountKey: string) => void) | null): void {
  opener = fn;
}

export function usageLevelState(accountKey: string): UsageLevelState | null {
  return states[accountKey] ?? null;
}

export interface UsageMonthInput {
  /** The statement's `periodStart` (the month it covers). */
  periodStart: string;
  /** The month's usage so far, in cents (before the included usage comes off). */
  cents: number;
  /** Meter counts for the card's "what the team got done". */
  counts?: Readonly<Record<string, number>>;
}

/**
 * Fold one statement into the account's level. Returns the level state, or
 * null when the month can't be read. `announce: false` updates the level
 * without a card (for a viewer who is not an owner of the account).
 */
export function observeUsageLevel(
  accountKey: string,
  accountName: string,
  input: UsageMonthInput,
  opts: { announce?: boolean; storage?: LevelStorage | null } = {},
): UsageLevelState | null {
  const month = monthOf(input.periodStart);
  if (!month || !Number.isFinite(input.cents)) return null;
  const who = viewer;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const stored: LevelRecord | null = who ? loadLevelRecord(storage, who, accountKey) : null;
  const prior = states[accountKey];
  // The in-memory state can be ahead of storage (storage refused a write),
  // but only a state folded for this same person may stand in for the record.
  const ownPrior = prior && who !== null && prior.viewer === who ? prior : null;
  const base: LevelRecord | null =
    stored ?? (ownPrior ? { bestCents: ownPrior.bestCents, bestMonth: ownPrior.bestMonth, level: ownPrior.level, announced: ownPrior.level } : null);
  const folded = observeMonth(base, { month, cents: input.cents });
  const announce = opts.announce === false ? null : folded.announce;
  // Without a card, the level is still recorded but not as announced, so the
  // person gets the card the first time they may see it.
  const record = opts.announce === false ? { ...folded.record, announced: base?.announced ?? 0 } : folded.record;
  const saved = who ? saveLevelRecord(storage, who, accountKey, record) : false;
  const willAnnounce = announce !== null && saved;
  const next: UsageLevelState = {
    level: record.level,
    bestCents: record.bestCents,
    bestMonth: record.bestMonth,
    freshAt: willAnnounce ? Date.now() : (prior?.freshAt ?? null),
    viewer: who,
  };
  if (
    !prior ||
    prior.level !== next.level ||
    prior.bestCents !== next.bestCents ||
    prior.bestMonth !== next.bestMonth ||
    prior.freshAt !== next.freshAt ||
    prior.viewer !== next.viewer
  ) {
    states = { ...states, [accountKey]: next };
  }
  if (willAnnounce) {
    announceUsageLevel({
      accountKey,
      accountName,
      level: announce,
      month,
      counts: input.counts ?? null,
      onOpen: opener ? () => opener?.(accountKey) : null,
    });
  }
  return next;
}

/**
 * Fold a Core menu read (CoreUsageView) into the account's level. Only a
 * month statement counts: trial usage is a trial total, not a month, and an
 * account not on usage pricing has no month to count.
 */
export function observeCoreView(accountKey: string, view: CoreUsageView | null | undefined): UsageLevelState | null {
  if (!view || view.kind !== "ready" || !view.usage) return usageLevelState(accountKey);
  const usage = view.usage;
  if (usage.mode !== "allowance" || !usage.periodStart || usage.totalCents === null) return usageLevelState(accountKey);
  return observeUsageLevel(accountKey, view.companyName, {
    periodStart: usage.periodStart,
    cents: usage.totalCents,
    counts: usage.counts,
  });
}

/** The parts of a Settings > Usage line (usage-accounts-model AccountRowView) the level reads. */
export interface LevelRowLike {
  kind: string;
  trial?: unknown;
  usage?: { periodStart: string; usageCents: number; lines: readonly unknown[] } | null;
}

/** Fold a Settings > Usage line into the account's level; trial lines and old plans don't count. */
export function observeAccountRow(accountKey: string, accountName: string, view: LevelRowLike | null | undefined): UsageLevelState | null {
  if (!view || view.kind !== "ready" || view.trial || !view.usage) return usageLevelState(accountKey);
  return observeUsageLevel(accountKey, accountName, {
    periodStart: view.usage.periodStart,
    cents: view.usage.usageCents,
    counts: countsFromLines(view.usage.lines),
  });
}

/** Test seam. */
export function __resetUsageLevelsForTests(): void {
  viewer = null;
  states = {};
  opener = null;
}

registerAccountCache(() => {
  states = {};
  dismissLevelCards();
});
