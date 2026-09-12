/**
 * Setup as a Local bot (bots v2, step 3).
 *
 * Setup used to be a scripted `/setup` session rendered as chat turns from a
 * fake sender. It is now a real Local bot named `setup`, created from the core
 * `setup` worker template and talked to in its own DM like any other bot. The
 * bot stays after onboarding as the always-there "how do I…" helper, so a
 * fresh install is never a install with no bots.
 *
 * This module is pure: the copy, the name/worker/runtime rules, and the small
 * launcher contract the surfaces use (the #welcome hero and Home's
 * "Finish setting up HQ" card). The host (`DesktopApp.svelte`) implements the
 * launcher on top of `createBotEntry`, so the progress card, the DM select and
 * the avatar plumbing are the same ones the New bot flow uses.
 *
 * WORDING: "setup bot", never "agent".
 */

import type { LocalBotRow } from "@hq/platform";

/**
 * FALLBACK FLAG (one build only). `true` = Run Setup creates the setup bot.
 * Flip to `false` to put the old scripted `/setup` session back in charge
 * everywhere, without unpicking the wiring. The failure path below also drops
 * back to the scripted run on its own, so a person is never stuck; this flag
 * exists so the whole step can be reverted from one line if the bot path
 * misbehaves on the private build.
 */
export const SETUP_BOT_MODE = true;

/** Reserved bot name; hq-cli reserves it for `--worker setup`. */
export const SETUP_BOT_NAME = "setup";
/** Core worker template the bot is created from (`core/workers/public/setup`). */
export const SETUP_BOT_WORKER = "setup";

/**
 * The bot's first message, sent by the runtime the moment it starts
 * (`hq bot create --intro`) instead of waiting ~30 s for a model turn. One
 * short paragraph, then what happens next. Keep it under 500 characters — the
 * CLI's limit for `--intro`.
 */
export const SETUP_BOT_INTRO =
  "Hi — I'm your setup bot. I run right here on this Mac under your own coding tool login, " +
  "and I'll stick around afterwards for any \"how do I…\" you have. " +
  "Here's what we'll do next: check the tools on this Mac, sign you in to HQ Cloud, create or join your company, " +
  "bring across anything you already have, learn a little about you, and set up your first real bot. " +
  "Say hi whenever you're ready.";

/** Hero + button copy for the setup-bot path. */
export const SETUP_BOT_COPY = {
  /** Create it and open the conversation. */
  run: "Run Setup",
  /** One already exists: this only opens the conversation. */
  open: "Open your setup bot",
  /** Home's setup card, where "Run Setup" would not say what happens. */
  create: "Create your setup bot",
  /** Home's setup card, in place of "open your agent and run /setup". */
  cardBody:
    "Your HQ folder isn't ready yet. Your setup bot finishes it for you — it runs on this Mac under your own coding tool login.",
  /** While the CLI is provisioning. */
  starting: "Starting…",
  /** Under the hero, before the first click. */
  body:
    "Setup happens in a conversation with your setup bot. It runs on this Mac under your own coding tool login, " +
    "walks you through getting started, and stays afterwards for anything you need.",
  /** Under the hero once the bot exists. */
  bodyExisting:
    "Your setup bot is in your messages. Open the conversation to keep going — it picks up wherever you left off.",
  /** After a failed create. */
  retry: "Retry",
  /** The way through when creating the bot will not work right now. */
  fallback: "Use the step-by-step setup instead",
} as const;

/** No coding tool is signed in, so the CLI cannot start a bot. */
export const SETUP_BOT_NO_RUNTIME =
  "No coding tool is signed in on this Mac yet. Sign in to Claude Code, Codex, or Grok, then retry.";

/** The host has no bots group at all (web build). */
export const SETUP_BOT_UNAVAILABLE = "The setup bot is only available in the HQ desktop app.";

/** Runtimes the setup bot may run under, in the order it prefers them. */
export const SETUP_BOT_RUNTIME_ORDER: ReadonlyArray<LocalBotRow["runtime"]> = ["claude", "codex", "grok"];

/** Minimal reference to the setup bot: enough to open its DM. */
export interface SetupBotRef {
  agentUid: string;
  name: string;
}

/** What starting the setup bot did (or why it could not). */
export type SetupBotStart =
  | { ok: true; existing: boolean }
  | { ok: false; reason: string };

/**
 * What a surface needs to offer the setup bot. Implemented once by the host;
 * both #welcome and Home's setup card take the same object.
 */
export interface SetupBotLauncher {
  /** A `setup` bot already exists on this Mac. */
  existing: boolean;
  /** A runtime is signed in, so creating one can succeed. */
  ready: boolean;
  /** Open the existing bot's DM, or create it and open the new one. */
  start(): Promise<SetupBotStart>;
}

/** The setup bot among this Mac's local bots, if it exists. */
export function findSetupBot(bots: readonly LocalBotRow[] | null | undefined): SetupBotRef | null {
  const bot = (bots ?? []).find((candidate) => candidate.name.trim().toLowerCase() === SETUP_BOT_NAME);
  return bot && bot.agentUid.trim() ? { agentUid: bot.agentUid.trim(), name: bot.name } : null;
}

/**
 * The runtime a new setup bot should think with: the first signed-in one, in
 * preference order. Null when the host has not answered yet or nothing is
 * signed in — the caller then says so instead of creating a bot that cannot
 * start.
 */
export function firstSignedInRuntime(
  ready: Record<string, boolean> | null | undefined,
): LocalBotRow["runtime"] | null {
  if (!ready) return null;
  return SETUP_BOT_RUNTIME_ORDER.find((runtime) => ready[runtime] === true) ?? null;
}

/** Label for the one primary action on #welcome / the Home setup card. */
export function setupBotActionLabel(launcher: Pick<SetupBotLauncher, "existing"> | null | undefined): string {
  return launcher?.existing ? SETUP_BOT_COPY.open : SETUP_BOT_COPY.run;
}
