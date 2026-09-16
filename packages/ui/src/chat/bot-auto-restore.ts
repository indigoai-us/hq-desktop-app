/**
 * BOTS COME BACK BY THEMSELVES.
 *
 * The owner's words after a fresh install: "I don't understand, the whole
 * point of our project was to automatically start up local bots when you
 * installed the app." He opened the setup bot's DM, typed "hi", and read
 * "Not answered yet — this bot isn't running on this computer." The
 * mechanism was already there and already worked (`hq bot restore` brought
 * both bots online in about five seconds on the VM); what the product
 * did wrong was ask for a click to start it, on a notice that sat above the
 * fold where he never saw it.
 *
 * So the click goes away. When the account's own listing says a bot the person
 * owns is not here and this Mac could run it, and a runtime is signed in, the
 * app brings it back on its own — single-flight, backed off per bot, never for
 * a company bot, and capped so a bot that cannot come back does not have the
 * app trying forever.
 *
 * ONE THING IT NEVER DOES BY ITSELF: take a bot off a Mac it is running on.
 * Bringing a bot here re-issues its machine credentials, and the old secret
 * stops working — so an automatic restore on a second computer would kill
 * every bot on the first, with no click and nothing said. A bot the listing
 * shows as live elsewhere is left to the manual surfaces, which say what
 * starting it here costs.
 *
 * Pure on purpose: the decision, the budget and every sentence are unit-tested
 * without a DOM. `DesktopApp.svelte` owns the state, the calls and the
 * rendering.
 *
 * WORDING: "bot", never "agent". Nothing the CLI or the API says is rendered.
 */

import type { LocalBotRow, RemoteBotRow } from "@hq/platform";

import { botRunsHere } from "./bot-runnability.js";
import { botLiveElsewhere, botsNotHere, type RemoteBotListing } from "./bot-restore.js";

/**
 * How many times the app may bring ONE bot back by itself in a session.
 *
 * A bot that cannot come back — a credential the cloud will not re-issue, a
 * runtime that refuses it — must not turn into a restore on every listing for
 * as long as the app is open. Three tries across three listings is enough to
 * ride out a transient failure; after that the person gets the manual notice,
 * which is honest about needing them.
 */
export const AUTO_RESTORE_MAX_ATTEMPTS = 3;

/**
 * The quietest a retry may be.
 *
 * A fresh install produces two listings inside a second — the poll at mount,
 * and the one the setup bot's DM asks for as it opens — so "retry on the next
 * listing" alone would spend the whole budget before anything transient had a
 * chance to clear. One local poll apart is enough to tell a blip from a wall.
 */
export const AUTO_RESTORE_RETRY_MS = 30_000;

/** True when a bot tried at `lastAttemptAt` may be tried again. */
export function canRetryAutoRestore(lastAttemptAt: number | null, now: number): boolean {
  return lastAttemptAt === null || now - lastAttemptAt >= AUTO_RESTORE_RETRY_MS;
}

/** Automatic attempts made this session, keyed by agent uid. */
export type AutoRestoreAttempts = Record<string, number>;

/**
 * When each bot was last tried automatically, keyed by agent uid.
 *
 * PER BOT, not per listing. The gate used to be one timestamp against one
 * fingerprint of the whole listing, which held as long as every attempt
 * covered every candidate — and stopped holding the moment a send brought ONE
 * bot back on its own: the next listing was a different fingerprint, so it
 * went again at once instead of waiting. What is charged and what is waited
 * for are now the same thing, so they cannot drift apart.
 */
export type AutoRestoreLastAttempts = Record<string, number>;

/** The bots whose back-off has expired (or that have never been tried). */
export function autoRestoreDue(
  lastAttemptAt: AutoRestoreLastAttempts,
  bots: readonly RemoteBotRow[],
  now: number,
): RemoteBotRow[] {
  return bots.filter((bot) =>
    canRetryAutoRestore(lastAttemptAt[bot.agentUid.trim()] ?? null, now),
  );
}

/** Stamp an automatic attempt against each of these bots. */
export function noteAutoRestoreAttempt(
  lastAttemptAt: AutoRestoreLastAttempts,
  bots: readonly RemoteBotRow[],
  now: number,
): AutoRestoreLastAttempts {
  const next = { ...lastAttemptAt };
  for (const bot of bots) {
    const uid = bot.agentUid.trim();
    if (uid) next[uid] = now;
  }
  return next;
}

/**
 * The bots an automatic restore would bring back: on the account's own
 * listing, not here, runnable on this Mac, not already running here — and NOT
 * running on another computer.
 *
 * That last one is the difference between a convenience and a theft. Bringing
 * a bot here re-issues its machine credentials and the old secret stops
 * working, so adopting a bot that is live on another Mac takes it off that Mac
 * — silently, seconds after someone opens the app on a second computer, with
 * nothing on either screen saying so. A person may choose that (the banner,
 * Settings and "Start on this computer" all still offer it, and say what it
 * costs); the app may not choose it for them. A wiped or reinstalled Mac has
 * no process left to beat, so the case this whole feature exists for is
 * untouched.
 *
 * A listing that FAILED yields nothing. Restoring goes through HQ Cloud, so a
 * listing the app could not read can never be the basis for acting by itself —
 * the same rule the prompt already follows, and the reason a 404 cloud cannot
 * make the app churn.
 */
export function autoRestoreCandidates(
  listing: RemoteBotListing | null | undefined,
  local: readonly LocalBotRow[] | null | undefined,
  now: number = Date.now(),
): RemoteBotRow[] {
  if (!listing || listing.failure) return [];
  return botsNotHere(listing.rows).filter(
    (bot) => !botRunsHere(local, bot.agentUid) && !botLiveElsewhere(bot, now),
  );
}

/** The rows an automatic restore is holding back because they are live elsewhere. */
export function autoRestoreHeldBack(
  listing: RemoteBotListing | null | undefined,
  local: readonly LocalBotRow[] | null | undefined,
  now: number = Date.now(),
): RemoteBotRow[] {
  if (!listing || listing.failure) return [];
  return botsNotHere(listing.rows).filter(
    (bot) => !botRunsHere(local, bot.agentUid) && botLiveElsewhere(bot, now),
  );
}

/**
 * A stable fingerprint of a set of bots, order-independent: the same bots in a
 * different listing order are the same set.
 */
export function autoRestoreStateKey(bots: readonly RemoteBotRow[]): string {
  return [...new Set(bots.map((bot) => bot.agentUid.trim()).filter(Boolean))].sort().join("|");
}

/**
 * Is `bots` exactly the set `hq bot restore` would bring back?
 *
 * The bulk command takes no names: it brings back every bot the account owns
 * that is not set up here, full stop. That is the right call — one process,
 * one token, one pass — as long as the app is asking for precisely that set.
 * The moment it is not (a bot held back because it is live on another Mac, or
 * one whose automatic budget is spent), the bulk call would restore bots
 * nobody asked for and charge them to nobody, so the caller has to go bot by
 * bot instead.
 */
export function autoRestoreCoversAll(
  bots: readonly RemoteBotRow[],
  everyMissingHere: readonly RemoteBotRow[],
): boolean {
  return autoRestoreStateKey(bots) === autoRestoreStateKey(everyMissingHere);
}

/** The candidates that still have budget left this session. */
export function autoRestoreAllowed(
  attempts: AutoRestoreAttempts,
  candidates: readonly RemoteBotRow[],
): RemoteBotRow[] {
  return candidates.filter(
    (bot) => (attempts[bot.agentUid.trim()] ?? 0) < AUTO_RESTORE_MAX_ATTEMPTS,
  );
}

/** Count one automatic attempt against each of these bots. */
export function countAutoRestoreAttempt(
  attempts: AutoRestoreAttempts,
  bots: readonly RemoteBotRow[],
): AutoRestoreAttempts {
  const next = { ...attempts };
  for (const bot of bots) {
    const uid = bot.agentUid.trim();
    if (!uid) continue;
    next[uid] = (next[uid] ?? 0) + 1;
  }
  return next;
}

/**
 * True when nothing automatic is left to try for these bots — the point at
 * which the manual notice is the honest surface again.
 */
export function autoRestoreExhausted(
  attempts: AutoRestoreAttempts,
  candidates: readonly RemoteBotRow[],
): boolean {
  return candidates.length > 0 && autoRestoreAllowed(attempts, candidates).length === 0;
}

// ── What the person reads while it happens ──────────────────────────────────
//
// Policy `transient-indicators-clear-on-newer-event-not-time-window`: none of
// these is cleared by a timer. "Bringing back" is replaced by the finished
// sentence, and the finished sentence by the next thing that happens.

/** While `hq bot restore --all` runs. */
export const AUTO_RESTORE_RUNNING = "Bringing back your bots…";

/** In a DM whose own bot is being brought back right now. */
export const AUTO_RESTORE_STARTING_THIS_BOT = "Starting this bot on this computer…";

/** Names in a sentence: "setup", "setup and test-bot", "a, b and c". */
export function joinBotNames(names: readonly string[]): string {
  const clean = names.map((name) => name.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0]!;
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/** When they are back: "setup and test-bot are back online." */
export function autoRestoreDoneLine(names: readonly string[]): string {
  const subject = joinBotNames(names);
  if (!subject) return "";
  return `${subject} ${names.length === 1 ? "is" : "are"} back online.`;
}

/**
 * When some could not come back: one plain sentence naming them, plus the
 * reason sentence the app already has for a listing that failed (runtime not
 * signed in / needs a newer HQ Cloud / couldn't reach HQ Cloud). Never the
 * CLI's words.
 */
export function autoRestoreFailedLine(
  names: readonly string[],
  reason: string | null | undefined,
): string {
  const subject = joinBotNames(names);
  const head = subject
    ? `${subject} couldn't be brought back to this computer.`
    : "Your bots couldn't be brought back to this computer.";
  const tail = (reason ?? "").trim();
  return tail ? `${head} ${tail}` : head;
}
