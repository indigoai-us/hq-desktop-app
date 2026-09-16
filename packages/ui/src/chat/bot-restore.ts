/**
 * Bots come back after a reinstall.
 *
 * `hq bot list` only knows THIS computer, so the desktop could not tell two
 * very different states apart: "you have no such bot" and "you own this bot,
 * its identity and memory are safe in HQ, and nothing here can run it". The
 * owner hit the second one — a fresh Mac on the same account, a DM with
 * test-bot spinning for 41 s while the bot's own setup said it could not run
 * here — because the cloud half of the bot was invisible to the app.
 *
 * `hq bot list --remote` is the source of truth that closes it: every local
 * bot the account owns, each flagged `here` or not. From that one listing come
 * all three surfaces in this module's copy — the honest DM notice with a way
 * out ("Start on this computer" → `hq bot adopt`), the one-time prompt after a
 * fresh install ("Restore all" → `hq bot restore --all`), and the Settings
 * rows for bots that live elsewhere.
 *
 * Pure on purpose: the selection rules, the dismissal memory and every
 * sentence are unit-tested without a DOM, and the host (`DesktopApp.svelte`,
 * `BotsSettingsPane.svelte`) owns the state and the rendering.
 *
 * WORDING: "bot", never "agent". Nothing the CLI or the API says is ever
 * rendered — see `plainBotFailure`.
 */

import type { BotRestoreResult, BotRestoreRow, RemoteBotRow } from "@hq/platform";

import { plainBotFailure } from "./local-bots.js";

/**
 * How often the shell re-reads the account's own bots. Four times slower than
 * the local listing on purpose: `hq bot list --remote` is a cloud round trip,
 * and "which bots do I own" changes on the scale of a reinstall, not a
 * heartbeat. Every surface that changes it (adopt, restore, Check again)
 * refreshes immediately rather than waiting for this.
 */
export const REMOTE_BOTS_POLL_MS = 120_000;

/** Bots the account owns that this computer cannot run, in listing order. */
export function botsNotHere(
  remote: readonly RemoteBotRow[] | null | undefined,
): RemoteBotRow[] {
  return (remote ?? []).filter((bot) => bot.here !== true && bot.agentUid.trim() !== "");
}

/**
 * The owned local bot behind this agent uid that is NOT set up here, or null.
 *
 * Null covers both "not the person's bot" and "runs here fine" — and, by
 * construction, every cloud/fleet agent: `hq bot list --remote` lists local
 * bots only, so an agent that is not on it keeps whatever behaviour it had.
 */
export function ownedBotNotHere(
  remote: readonly RemoteBotRow[] | null | undefined,
  agentUid: string | null | undefined,
): RemoteBotRow | null {
  const uid = (agentUid ?? "").trim();
  if (!uid) return null;
  return botsNotHere(remote).find((bot) => bot.agentUid.trim() === uid) ?? null;
}

/** The action on the "cannot run here" notice, now that there is a real one. */
export const BOT_START_HERE = "Start on this computer";
/** While `hq bot adopt` is running. */
export const BOT_START_HERE_BUSY = "Starting…";

/** Under the notice, so the button is not a leap of faith. */
export const BOT_START_HERE_EXPLAINER =
  "It keeps its name, its memory and this conversation — only the part that runs it is rebuilt here.";

/** A failed adopt, when there is nothing quotable to say. */
export function adoptFallbackNotice(name: string): string {
  return `Could not bring ${name} back to this computer. Please try again.`;
}

/** Retry on a failed adopt. */
export const BOT_START_HERE_RETRY = "Retry";

// ── The one-time prompt after a fresh install ────────────────────────────────

/** Heading on the restore prompt. */
export const BOT_RESTORE_TITLE = "Your bots are waiting";

/**
 * One sentence saying what is true and what "Restore all" does. Counted, so a
 * person with one bot is not told about "bots".
 */
export function botRestorePromptBody(count: number): string {
  const subject = count === 1 ? "One of your bots isn't" : `${count} of your bots aren't`;
  return `${subject} set up on this computer yet. Restoring brings ${
    count === 1 ? "it" : "them"
  } back here — same name, same memory, same conversations.`;
}

export const BOT_RESTORE_ALL = "Restore all";
export const BOT_RESTORE_ALL_BUSY = "Restoring…";
export const BOT_RESTORE_DISMISS = "Not now";
/** Settings › Bots re-offers it after a dismissal. */
export const BOT_RESTORE_FROM_SETTINGS = "Restore my bots";

/** Nothing quotable came back from `hq bot restore`. */
export const BOT_RESTORE_FAILED =
  "Could not bring your bots back right now. Please try again.";

/**
 * Remembered per machine, so the prompt is offered once and not at every
 * launch. Settings › Bots is where a person asks for it again.
 */
export const BOT_RESTORE_DISMISSED_KEY = "hq.bots.restore.dismissed";

/** Minimal `localStorage` shape, so this stays testable and host-agnostic. */
export interface RestorePromptMemory {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** True once this machine has been offered the prompt and said not now. */
export function botRestorePromptDismissed(store: RestorePromptMemory | null | undefined): boolean {
  try {
    return store?.getItem(BOT_RESTORE_DISMISSED_KEY) === "1";
  } catch {
    // A host with storage disabled simply never remembers; better than throwing
    // inside the shell's render path.
    return false;
  }
}

/** Remember the dismissal. Never throws — a failure only costs one re-offer. */
export function rememberBotRestoreDismissed(store: RestorePromptMemory | null | undefined): void {
  try {
    store?.setItem(BOT_RESTORE_DISMISSED_KEY, "1");
  } catch {
    /* storage disabled */
  }
}

// ── Results ─────────────────────────────────────────────────────────────────

/** What happened to one bot, in a person's words. */
export function botRestoreRowLine(row: BotRestoreRow): string {
  switch (row.action) {
    case "restored":
      return `${row.name} is back on this computer.`;
    case "repaired":
      return `${row.name} was already here — its sign-in was refreshed.`;
    case "skipped":
    case "would-skip":
      return `${row.name} was already set up here.`;
    case "would-restore":
      return `${row.name} would come back to this computer.`;
    case "would-repair":
      return `${row.name} would have its sign-in refreshed.`;
    case "failed":
    default:
      // `detail` is the CLI's own words on this path: a sentence when it wrote
      // one for a person, the written fallback when it did not.
      return plainBotFailure(row.detail, `${row.name} could not be brought back.`);
  }
}

/** True when a row is one a person should read as gone wrong. */
export function botRestoreRowFailed(row: BotRestoreRow): boolean {
  return row.action === "failed";
}

/** The headline over the per-bot list once a restore finishes. */
export function botRestoreSummary(result: BotRestoreResult): string {
  const back = result.restored;
  const failed = result.failed;
  if (back === 0 && failed === 0) return "Every bot you own was already set up here.";
  if (failed === 0) {
    return back === 1 ? "One bot is back on this computer." : `${back} bots are back on this computer.`;
  }
  if (back === 0) {
    return failed === 1
      ? "One bot could not be brought back."
      : `${failed} bots could not be brought back.`;
  }
  return `${back} of your bots are back; ${failed} could not be brought back.`;
}
