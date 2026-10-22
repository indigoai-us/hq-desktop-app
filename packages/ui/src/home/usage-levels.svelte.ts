/**
 * Company levels, live (usage-only-pricing US-019): what each account's level
 * is right now, for the Core menu meter and Settings > Usage, and the one-time
 * accomplishment card when a level unlocks.
 *
 * Both surfaces call `observeUsageLevel` with each statement they read. The
 * level comes from the server: the first read of an account in a session also
 * reads its usage history (`GET /v1/billing/usage/history`, hq-pro #5087)
 * once, through the loader the shell sets, and the best month is the largest
 * of every month the history returns and this month's statement. Nothing
 * about spend is stored on the device; the only stored thing is the highest
 * level a card was shown for, per signed-in person and account.
 *
 * Cards need the history. Until it answers, reads show this month's level and
 * hold the card; then the held read is folded again, so a card names the
 * highest new level once. A failed, refused (403 for admins and members) or
 * missing (404) history read, an unreadable body, or a host with no loader
 * shows this month's level and never a card: without the history the app
 * cannot tell a new level from one an earlier month already reached. A card
 * fires only when its record could be stored, so it cannot repeat on every
 * read.
 *
 * The history covers the last 12 months, so a level reached only by a month
 * older than that is no longer shown.
 */

import { registerAccountCache } from "../common/account-caches.js";
import {
  bestOfMonths,
  countsFromLines,
  levelForCents,
  loadCardRecord,
  monthOf,
  readUsageHistory,
  saveCardRecord,
  type LevelStorage,
  type MonthObservation,
  type UsageHistory,
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

/**
 * Reads an account's usage history: a company uid, or the personal key. An
 * `{ ok, value }` result like the adapter's; null when this host has none.
 */
export type UsageHistoryLoader = (
  accountKey: string,
) => Promise<{ ok: boolean; value?: unknown }> | null | undefined;

let historyLoader: UsageHistoryLoader | null = null;

/** A held read: folded again, with its card, once the history has answered. */
interface HeldRead {
  accountName: string;
  input: UsageMonthInput;
  opts: ObserveOptions;
}

/** One history read per account per signed-in person per session. */
interface HistoryRead {
  viewer: string;
  status: "pending" | "ok" | "failed";
  history: UsageHistory | null;
  /** This device had no card record for the person and account when the read began. */
  fresh: boolean;
  held: HeldRead | null;
}

const historyReads = new Map<string, HistoryRead>();

/** Where the history comes from (the shell sets it; null turns history, and so cards, off). */
export function setUsageLevelHistoryLoader(fn: UsageHistoryLoader | null): void {
  historyLoader = fn;
  historyReads.clear();
}

function defaultStorage(): LevelStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The signed-in person (`prs_*`). The history is read and cards fire only with one. */
export function setUsageLevelViewer(uid: string | null | undefined): void {
  const next = uid?.trim() || null;
  if (next === viewer) return;
  const previous = viewer;
  viewer = next;
  // Levels read before anyone was known stay on screen (this month only) and
  // are folded with the person's history on the next read. A change of person
  // forgets the last person's levels and cards.
  if (previous !== null) {
    states = {};
    historyReads.clear();
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

/**
 * The signed-in person right now. A surface that starts a usage read keeps
 * this and passes it back as `viewer` with the answer, so a read that
 * answers after a change of person is dropped instead of being folded into
 * the new person's level.
 */
export function usageLevelViewer(): string | null {
  return viewer;
}

export function usageLevelState(accountKey: string): UsageLevelState | null {
  return states[accountKey] ?? null;
}

/** How a read is folded: `announce: false` (no card), `storage`, and `viewer` (whose read it was). */
export interface ObserveOptions {
  announce?: boolean;
  storage?: LevelStorage | null;
  /**
   * The signed-in person when the read began (`usageLevelViewer()`). When it
   * is given and is no longer the signed-in person, the read is dropped.
   */
  viewer?: string | null;
}

export interface UsageMonthInput {
  /** The statement's `periodStart` (the month it covers). */
  periodStart: string;
  /** The month's usage so far, in cents (before the included usage comes off). */
  cents: number;
  /** Meter counts for the card's "what the team got done". */
  counts?: Readonly<Record<string, number>>;
}

function setState(accountKey: string, next: UsageLevelState): void {
  const prior = states[accountKey];
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
  opts: ObserveOptions = {},
): UsageLevelState | null {
  // A read that began for another person (or before a sign-out) is not this
  // person's usage: drop it, and leave their level as it is.
  if (opts.viewer !== undefined && (opts.viewer?.trim() || null) !== viewer) return null;
  const month = monthOf(input.periodStart);
  if (!month || !Number.isFinite(input.cents)) return null;
  const who = viewer;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  let read: HistoryRead | null = null;
  if (who && historyLoader) {
    read = historyReads.get(accountKey) ?? null;
    if (!read || read.viewer !== who) read = startHistoryRead(accountKey, who, storage);
  }
  const ok = read?.status === "ok" ? read.history : null;
  const thisMonth: MonthObservation = { month, cents: Math.max(0, input.cents) };
  const best = bestOfMonths([...(ok?.months ?? []), thisMonth]);
  const level = levelForCents(best?.cents ?? 0);
  const prior = states[accountKey];

  let announce: number | null = null;
  if (who && ok && opts.announce !== false) {
    const announced = loadCardRecord(storage, who, accountKey)?.announced ?? 0;
    if (level > announced && saveCardRecord(storage, who, accountKey, { announced: level })) announce = level;
  } else if (read?.status === "pending" && opts.announce !== false) {
    // Hold the card until the history answers; the level still shows now.
    read.held = { accountName, input, opts };
  }

  const next: UsageLevelState = {
    level,
    bestCents: best?.cents ?? 0,
    bestMonth: best?.month ?? null,
    freshAt: announce !== null ? Date.now() : prior && prior.viewer === who ? prior.freshAt : null,
    viewer: who,
  };
  setState(accountKey, next);
  if (announce !== null) {
    // The level was reached by the best month, which can be an earlier month
    // from the history; this read's counts describe this month only.
    const cardMonth = best?.month ?? month;
    announceUsageLevel({
      accountKey,
      accountName,
      level: announce,
      month: cardMonth,
      counts: cardMonth === month ? (input.counts ?? null) : null,
      onOpen: opener ? () => opener?.(accountKey) : null,
    });
  }
  return next;
}

function startHistoryRead(accountKey: string, who: string, storage: LevelStorage | null): HistoryRead {
  const read: HistoryRead = {
    viewer: who,
    status: "pending",
    history: null,
    fresh: loadCardRecord(storage, who, accountKey) === null,
    held: null,
  };
  historyReads.set(accountKey, read);
  let pending: ReturnType<UsageHistoryLoader> = null;
  try {
    pending = historyLoader?.(accountKey) ?? null;
  } catch {
    pending = null;
  }
  void Promise.resolve(pending)
    .then((res) => (res && res.ok ? readUsageHistory(res.value) : null))
    .catch(() => null)
    .then((history) => finishHistoryRead(accountKey, read, history, storage));
  return read;
}

function finishHistoryRead(accountKey: string, read: HistoryRead, history: UsageHistory | null, storage: LevelStorage | null): void {
  // Sign-out or a change of person while the read was out: it is not theirs.
  if (historyReads.get(accountKey) !== read || viewer !== read.viewer) return;
  read.status = history ? "ok" : "failed";
  read.history = history;
  const held = read.held;
  read.held = null;
  if (history && read.fresh && loadCardRecord(storage, read.viewer, accountKey) === null) {
    // A device with no record of its own for this person and account: the
    // person most likely saw the cards for levels the earlier months reached
    // on another device, so those count as shown. Every month before this
    // one counts, complete or not: hq-pro marks a past month incomplete when
    // a meter is missing, and its level was still shown when it was reached.
    // A higher level this month reaches is not covered and still gets its card.
    const current = monthOf(held?.input.periodStart) ?? monthOf(new Date().toISOString());
    const earlier = history.months.filter((m) => current === null || m.month < current);
    const earlierLevel = levelForCents(bestOfMonths(earlier)?.cents ?? 0);
    if (earlierLevel > 0) saveCardRecord(storage, read.viewer, accountKey, { announced: earlierLevel });
  }
  if (held) {
    observeUsageLevel(accountKey, held.accountName, held.input, held.opts);
  } else if (history) {
    // No read to fold (an `announce: false` read only): show the history's best month.
    const prior = states[accountKey];
    const best = bestOfMonths([...history.months, prior && prior.bestMonth ? { month: prior.bestMonth, cents: prior.bestCents } : null]);
    if (prior) setState(accountKey, { ...prior, level: levelForCents(best?.cents ?? 0), bestCents: best?.cents ?? 0, bestMonth: best?.month ?? null });
  }
}

/**
 * Fold a Core menu read (CoreUsageView) into the account's level. Only a
 * month statement counts: trial usage is a trial total, not a month, and an
 * account not on usage pricing has no month to count.
 */
export function observeCoreView(
  accountKey: string,
  view: CoreUsageView | null | undefined,
  opts: Pick<ObserveOptions, "viewer"> = {},
): UsageLevelState | null {
  if (!view || view.kind !== "ready" || !view.usage) return usageLevelState(accountKey);
  const usage = view.usage;
  if (usage.mode !== "allowance" || !usage.periodStart || usage.totalCents === null) return usageLevelState(accountKey);
  return observeUsageLevel(accountKey, view.companyName, {
    periodStart: usage.periodStart,
    cents: usage.totalCents,
    counts: usage.counts,
  }, opts);
}

/** The parts of a Settings > Usage line (usage-accounts-model AccountRowView) the level reads. */
export interface LevelRowLike {
  kind: string;
  trial?: unknown;
  usage?: { periodStart: string; usageCents: number; lines: readonly unknown[] } | null;
}

/** Fold a Settings > Usage line into the account's level; trial lines and old plans don't count. */
export function observeAccountRow(
  accountKey: string,
  accountName: string,
  view: LevelRowLike | null | undefined,
  opts: Pick<ObserveOptions, "viewer"> = {},
): UsageLevelState | null {
  if (!view || view.kind !== "ready" || view.trial || !view.usage) return usageLevelState(accountKey);
  return observeUsageLevel(accountKey, accountName, {
    periodStart: view.usage.periodStart,
    cents: view.usage.usageCents,
    counts: countsFromLines(view.usage.lines),
  }, opts);
}

/** Test seam. */
export function __resetUsageLevelsForTests(): void {
  viewer = null;
  states = {};
  opener = null;
  historyLoader = null;
  historyReads.clear();
}

registerAccountCache(() => {
  states = {};
  historyReads.clear();
  dismissLevelCards();
});
