/**
 * BOTS COME BACK BY THEMSELVES.
 *
 * The owner's words after a fresh install: "I don't understand, the whole
 * point of our project was to automatically start up local bots when you
 * installed the app." He opened the setup bot's DM, typed "hi", and read
 * "Not answered yet — this bot isn't running on this computer." The
 * mechanism was already there and already worked (`hq bot restore --all`
 * brought both bots online in about five seconds on the VM); what the product
 * did wrong was ask for a click to start it, on a notice that sat above the
 * fold where he never saw it.
 *
 * So the click goes away. When the account's own listing says a bot the person
 * owns is not here and this Mac could run it, and a runtime is signed in, the
 * app brings it back on its own — once per listing state, single-flight, never
 * for a company bot, and capped so a bot that cannot come back does not have
 * the app trying forever.
 *
 * Pure on purpose: the decision, the budget and every sentence are unit-tested
 * without a DOM. `DesktopApp.svelte` owns the state, the calls and the
 * rendering.
 *
 * WORDING: "bot", never "agent". Nothing the CLI or the API says is rendered.
 */

import type { LocalBotRow, RemoteBotRow } from "@hq/platform";

import { botRunsHere } from "./bot-runnability.js";
import { botsNotHere, type RemoteBotListing } from "./bot-restore.js";

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

/** True when a failed attempt against the SAME listing state may go again. */
export function canRetryAutoRestore(lastAttemptAt: number | null, now: number): boolean {
  return lastAttemptAt === null || now - lastAttemptAt >= AUTO_RESTORE_RETRY_MS;
}

/** Automatic attempts made this session, keyed by agent uid. */
export type AutoRestoreAttempts = Record<string, number>;

/**
 * The bots an automatic restore would bring back: on the account's own
 * listing, not here, runnable on this Mac, and not already running here.
 *
 * A listing that FAILED yields nothing. Restoring goes through HQ Cloud, so a
 * listing the app could not read can never be the basis for acting by itself —
 * the same rule the prompt already follows, and the reason a 404 cloud cannot
 * make the app churn.
 */
export function autoRestoreCandidates(
  listing: RemoteBotListing | null | undefined,
  local: readonly LocalBotRow[] | null | undefined,
): RemoteBotRow[] {
  if (!listing || listing.failure) return [];
  return botsNotHere(listing.rows).filter((bot) => !botRunsHere(local, bot.agentUid));
}

/**
 * A stable fingerprint of one listing state, so the app acts on it ONCE.
 *
 * Order-independent: the same set of bots in a different listing order is the
 * same state, and re-running a restore for it would be the churn this guards
 * against. A bot appearing or disappearing is a new state, which is exactly
 * when a fresh automatic attempt is wanted (a bot wiped by an update or a
 * crash comes back the same way a reinstall's does).
 */
export function autoRestoreStateKey(bots: readonly RemoteBotRow[]): string {
  return [...new Set(bots.map((bot) => bot.agentUid.trim()).filter(Boolean))].sort().join("|");
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
