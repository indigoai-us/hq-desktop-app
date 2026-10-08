/**
 * A local bot whose coding tool is missing, in words a person can act on.
 *
 * When a Local bot's model turn fails, hq-cli (`src/lib/bot/run.ts`) posts a
 * reply into the bot's DM that quotes the runtime's own error, for example
 * "I couldn't answer that one (claude kept failing: claude is not installed
 * or not on PATH)". A freshly wiped Mac with no Claude Code showed
 * exactly that. The CLI's words are machine text (policy
 * indigo-ui-never-raw-errors-always-heal-path), so the desktop replaces those
 * replies with a plain sentence when it renders them, and the DM offers the
 * guided install (see `localBotNeedsCodingTool`).
 *
 * Pure on purpose: matching and copy are unit-tested without a DOM.
 */

import type { LocalBotRow } from "@hq/platform";

const RUNTIME_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
};

/** "Claude Code" for `claude`; "your coding tool" for anything unknown. */
export function botRuntimeLabel(runtime: string | null | undefined): string {
  return RUNTIME_LABELS[(runtime ?? "").trim().toLowerCase()] ?? "your coding tool";
}

/**
 * The three failure replies hq-cli sends into a bot's DM. Each names the
 * runtime id and then quotes the runtime's error after "failed:" or
 * "kept failing:".
 */
const CLI_FAILURE_REPLY =
  /^(?:Sorry\s*[\u2014\u2013-]+\s*I couldn't (?:answer that one|get started on my own)\s*\(|I couldn't run this one\s*[\u2014\u2013-]+\s*)([a-z][a-z-]*) (?:kept failing|failed):\s*([\s\S]*)$/i;

/** The runtime's error says the tool is not on this computer at all. */
const RUNTIME_MISSING =
  /not installed|not on PATH|command not found|ENOENT|no such file or directory|could not find (?:the )?(?:claude|codex|grok)/i;

export interface PlainBotFailureReply {
  /** The sentence shown in place of the CLI's reply. */
  body: string;
  /** True when the failure was a missing coding tool (the install guide fixes it). */
  runtimeMissing: boolean;
}

/**
 * The plain replacement for a hq-cli failure reply, or null when `body` is an
 * ordinary message. `noun` is "Mac", "PC" or "computer".
 */
export function plainBotFailureReply(
  body: string | null | undefined,
  opts: { noun?: string } = {},
): PlainBotFailureReply | null {
  const text = (body ?? "").trim();
  if (!text) return null;
  const match = CLI_FAILURE_REPLY.exec(text);
  if (!match) return null;
  const noun = opts.noun?.trim() || "computer";
  const label = botRuntimeLabel(match[1]);
  const detail = match[2] ?? "";
  if (RUNTIME_MISSING.test(detail)) {
    return {
      body: `I couldn't answer because ${label} isn't installed on this ${noun}. Install it and sign in, then send your message again.`,
      runtimeMissing: true,
    };
  }
  return {
    body: `I couldn't answer that one. Try again in a bit, or check that ${label} is signed in on this ${noun}.`,
    runtimeMissing: false,
  };
}

/**
 * Replace hq-cli failure replies from bots (`agt_` senders) with their plain
 * sentence. Returns the same array when nothing changed, so a derived
 * timeline does not re-render for no reason.
 */
export function withPlainBotFailureReplies<
  T extends { fromPersonUid?: string | null; body?: string | null },
>(messages: T[], opts: { noun?: string } = {}): T[] {
  let changed = false;
  const next = messages.map((message) => {
    const from = (message.fromPersonUid ?? "").trim();
    if (!from.startsWith("agt_")) return message;
    const plain = plainBotFailureReply(message.body, opts);
    if (!plain) return message;
    changed = true;
    return { ...message, body: plain.body };
  });
  return changed ? next : messages;
}

/**
 * The coding tool a local bot runs on is not signed in here (or not
 * installed), and the host has said so. Unknown readiness (null) is not
 * "missing". A bot whose sign-in merely expired has its own banner
 * (`BotSignInBanner`), so the caller checks that first.
 */
export function localBotNeedsCodingTool(
  bot: Pick<LocalBotRow, "runtime"> | null | undefined,
  ready: Record<string, boolean> | null | undefined,
): boolean {
  if (!bot || !ready) return false;
  const runtime = (bot.runtime ?? "").trim().toLowerCase();
  if (!runtime || !(runtime in ready)) return false;
  return ready[runtime] !== true;
}

/** The one line above the install guide in a bot's DM. */
export function botNeedsCodingToolNotice(
  bot: { name?: string | null; displayName?: string | null; runtime?: string | null },
  opts: { noun?: string } = {},
): string {
  const noun = opts.noun?.trim() || "computer";
  const who = bot.displayName?.trim() || bot.name?.trim() || "This bot";
  return `${who} needs ${botRuntimeLabel(bot.runtime)} on this ${noun} to answer. Install it and sign in here, and ${who} picks up from there.`;
}
