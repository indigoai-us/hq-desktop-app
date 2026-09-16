/**
 * Can this bot actually run on THIS Mac, and what happens when starting it
 * fails (desktop UX feedback, round 5).
 *
 * The owner's VM showed the failure this module exists to stop. A setup bot
 * that lived only in the HQ Cloud account was adopted by the desktop, its DM
 * was opened, and the person typed into it — but no local config had ever
 * been written here, so every start answered `No bot named "setup"`. The
 * start was re-issued ~48 times, nothing surfaced, and the row sat under
 * "setup is still working…" forever.
 *
 * Two rules come out of that:
 *
 *   1. A bot with no local runtime is NOT a working bot. Say so, in the DM
 *      header and in the conversation, and never fake one or quietly create a
 *      duplicate.
 *   2. A start that failed for a definitive reason must not be re-issued.
 *      "No such bot" will answer the same way a thousand times; only a
 *      genuinely transient failure (a timeout, an unreachable CLI, a 5xx)
 *      earns another attempt, and even that is bounded.
 *
 * Pure on purpose: the classification, the bounded gate and the copy are
 * unit-tested without a DOM, and the host (`DesktopApp.svelte`) owns the
 * reactive state and the rendering.
 */

import type { LocalBotRow } from "@hq/platform";

/**
 * Why a start failed, as far as retrying is concerned.
 *
 * - `missing`   — this Mac has no such bot. Definitive, and the one case that
 *                 also means "the bot cannot run here at all".
 * - `blocked`   — a real, non-transient obstacle (not signed in, held for
 *                 promotion, refused). Definitive: retrying unchanged repeats it.
 * - `transient` — the CLI timed out or could not be reached. Worth another go,
 *                 up to `BOT_START_MAX_ATTEMPTS`.
 */
export type BotStartFailureKind = "missing" | "blocked" | "transient";

/** The CLI's "there is no bot by that name here" (hq-cli `requireBot`). */
const MISSING_SHAPES: readonly RegExp[] = [
  /\bno bot named\b/i,
  /\bno such bot\b/i,
  /\bbot\s+"[^"]*"\s+(?:does not exist|doesn't exist|was not found|not found)\b/i,
  /\bbot\b[^.]{0,40}\bis not set up on this (?:mac|computer)\b/i,
];

/** Shapes that mean "the same call could work in a moment". */
const TRANSIENT_SHAPES: readonly RegExp[] = [
  /did not finish within/i,
  /\btimed out\b/i,
  /\btimeout\b/i,
  /could not start the hq cli/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETDOWN|ENETUNREACH|EAI_AGAIN|EPIPE|EBUSY)\b/,
  /\bnetwork (?:error|is unreachable|unavailable)\b/i,
  /\btemporarily unavailable\b/i,
  /→\s*5\d{2}\b/,
  /\b5\d{2}\s+(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
];

/**
 * Classify a start failure from whatever the host relayed (the CLI's own
 * words — never rendered, see `plainBotFailure`).
 *
 * Unknown text is `blocked`, not `transient`: the cost of stopping one
 * recoverable failure early is one extra click, and the cost of guessing
 * "transient" is the loop this whole module exists to end.
 */
export function classifyBotStartFailure(raw: string | null | undefined): BotStartFailureKind {
  const text = (raw ?? "").trim();
  if (!text) return "blocked";
  if (MISSING_SHAPES.some((shape) => shape.test(text))) return "missing";
  if (TRANSIENT_SHAPES.some((shape) => shape.test(text))) return "transient";
  return "blocked";
}

/** A failure that will answer the same way next time. */
export function isDefinitiveBotStartFailure(kind: BotStartFailureKind): boolean {
  return kind !== "transient";
}

/** Attempts a single bot gets before the app stops trying by itself. */
export const BOT_START_MAX_ATTEMPTS = 3;

/** How many starts this bot has failed, and whether it may be started again. */
export interface BotStartAttempts {
  attempts: number;
  stopped: boolean;
  kind: BotStartFailureKind;
}

/** Per-bot start budget, keyed by the bot's name (what `start` takes). */
export type BotStartGate = Readonly<Record<string, BotStartAttempts>>;

/** False once a definitive failure landed, or the transient budget ran out. */
export function canStartBot(gate: BotStartGate, key: string): boolean {
  return !gate[key]?.stopped;
}

/** Count a failed start and close the gate when nothing more should be tried. */
export function recordBotStartFailure(
  gate: BotStartGate,
  key: string,
  kind: BotStartFailureKind,
): BotStartGate {
  const attempts = (gate[key]?.attempts ?? 0) + 1;
  const stopped = isDefinitiveBotStartFailure(kind) || attempts >= BOT_START_MAX_ATTEMPTS;
  return { ...gate, [key]: { attempts, stopped, kind } };
}

/** A start that worked (or a bot that came back) reopens the gate. */
export function clearBotStartGate(gate: BotStartGate, key: string): BotStartGate {
  if (!gate[key]) return gate;
  const { [key]: _cleared, ...rest } = gate;
  return rest;
}

/**
 * The honest state for a bot this account owns that has no runtime here.
 * Names the one thing that is true and the one thing that helps; it never
 * promises an action the desktop cannot perform.
 */
export const BOT_NOT_RUNNABLE_HERE =
  "This bot is set up on another computer and can't run here yet. Open it on that computer to keep going — messages you send here stay unanswered until it is running.";

/** Button on that notice: re-read this Mac's bots, once, on demand. */
export const BOT_NOT_RUNNABLE_RECHECK = "Check again";

/** Under a message sent to a bot that cannot run: it is not being worked on. */
export const BOT_MESSAGE_NOT_ANSWERED =
  "Not answered yet — this bot isn't running on this computer.";

/** Shown once the app has stopped trying to start a bot by itself. */
export const BOT_START_NO_MORE_RETRIES =
  "Nothing more will be tried automatically. Open the bot's profile to look into it.";

/** Generic, written fallback for a start failure with nothing to quote. */
export function botStartFallbackNotice(name: string): string {
  return `Could not start ${name} on this computer.`;
}

/**
 * Positive evidence from a fresh `hq bot list` that this bot really is running
 * on THIS computer: a live local process.
 *
 * Deliberately narrow. Presence in the listing is not evidence — the failure
 * this module exists for had `hq bot list` naming the bot, with its launch
 * agent reported installed, while every start answered "no such bot". Nor is
 * `online`: that is a server-side heartbeat, which a bot running on another
 * computer reports too. A local pid is the one claim only this Mac can make,
 * so it is the one that may reopen a closed gate without a person asking.
 */
export function botIsConfiguredHere(bot: LocalBotRow | null | undefined): boolean {
  return bot?.processAlive === true;
}

/** True when this Mac has the bot's own config (so it can actually run). */
export function botRunsHere(
  bots: readonly LocalBotRow[] | null | undefined,
  agentUid: string,
): boolean {
  const uid = agentUid.trim();
  if (!uid) return false;
  return (bots ?? []).some((bot) => bot.agentUid.trim() === uid);
}
