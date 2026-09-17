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

import { isAgentUid } from "./agent-thinking.js";

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
 * (`hq bot create --intro`) instead of waiting for a model turn. Two short
 * sentences: the plan, and that step one is starting now — never an open
 * "what would you like to do?", because the kickoff turn below follows it
 * automatically. Keep it under 500 characters (the CLI's `--intro` limit) and
 * on one line (the host rejects control characters).
 */
export const SETUP_BOT_INTRO =
  "Hi, I'm your setup bot, and together we'll get HQ ready: your tools, HQ Cloud, your company, " +
  "the work you already have, the apps you use, and your first bot. " +
  "I'm starting step one now by checking what's already set up on this Mac.";

/**
 * Prefix the setup template recognises (`core/workers/public/setup`, "When
 * you receive the kickoff").
 */
export const SETUP_BOT_KICKOFF_PREFIX = "Kickoff:";

/**
 * The first task the bot runs by itself right after the intro
 * (`hq bot create --kickoff`): one model turn, as if the person had sent it,
 * answered in the DM. It makes the bot start the walkthrough without waiting
 * for the person to type. Under 2000 characters and on one line.
 */
export const SETUP_BOT_KICKOFF =
  `${SETUP_BOT_KICKOFF_PREFIX} setup has just started and your hello already went out, naming the plan and saying you are starting step one now, ` +
  "so do not greet again or repeat the plan. " +
  "First work out where this HQ stands, quietly: read your setup-progress.md note if there is one, " +
  "check whether I am signed in to HQ Cloud and as whom, whether this HQ has a company, and which of the tools HQ leans on are missing. " +
  "Then begin the first unfinished step right away, exactly as your instructions for the kickoff say: " +
  "do the part you can do yourself, tell me in one line what you found or fixed, " +
  "and end with exactly one concrete question or one concrete action for me. " +
  "If the tools are all installed and working, also tell me I can say skip at any stage to jump to the end, as your instructions describe. " +
  "If setup is already finished, say so in one line and offer two or three concrete next moves drawn from this HQ, then ask which to start. " +
  "Never end with an open question like \"what would you like to do?\"";

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
  /** The bot is being started automatically on first open. */
  autoStarting: "Starting your setup bot…",
  /** Under the hero while the automatic start runs. */
  bodyStarting: "Your setup bot is starting on this Mac. Its conversation opens by itself in a moment.",
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

/**
 * Last-resort wording. Every start failure is mapped to a written sentence
 * before it reaches a person; nothing from the API or the CLI is ever shown
 * (see `plainBotFailure`).
 */
export const SETUP_BOT_GENERIC_FAILURE = "Could not start your setup bot. Please try again.";

/**
 * The account already owns a setup bot (the create came back "already
 * exists") but this Mac cannot find its conversation yet — the entity lives in
 * the cloud from an earlier install or another computer and the DM roster has
 * not caught up. Says what is true, and what to do, in the person's words.
 */
export const SETUP_BOT_ALREADY_ELSEWHERE =
  "Your account already has a setup bot from another computer. It shows up in your messages once HQ catches up — open it there to carry on.";

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
  /** The setup bot is being created right now (e.g. the automatic first-open start). */
  starting?: boolean;
  /** Failure from an automatic start, displayed by the same recovery UI. */
  error?: string | null;
  /** Open the existing bot's DM, or create it and open the new one. */
  start(): Promise<SetupBotStart>;
}

/** The setup bot among this Mac's local bots, if it exists. */
export function findSetupBot(bots: readonly LocalBotRow[] | null | undefined): SetupBotRef | null {
  const bot = (bots ?? []).find((candidate) => candidate.name.trim().toLowerCase() === SETUP_BOT_NAME);
  return bot && bot.agentUid.trim() ? { agentUid: bot.agentUid.trim(), name: bot.name } : null;
}

/** Tolerant reader for a contacts payload: `[…]` or `{ contacts: […] }`. */
function contactRows(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { contacts?: unknown }).contacts)
      ? (value as { contacts: unknown[] }).contacts
      : [];
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

function trimmedField(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * The account's setup bot as the CLOUD sees it, read off the DM roster
 * (`GET /v1/notify/contacts`).
 *
 * `hq bot list` only knows THIS Mac. Wipe the local state and keep the same
 * HQ account — a reinstall, or setting HQ up on a second Mac — and the local
 * list is empty while the account still owns the agent entity, so a create
 * comes back 409 "already exists". The roster is the one cloud-side view of a
 * person's own bots the desktop already has; the hq CLI exposes no "list my
 * remote bots" and no adopt call today.
 *
 * Matching is deliberately strict — an `agt_` uid whose display name is
 * exactly the reserved `setup` name. Personal bots join no company, so a
 * teammate's own setup bot is not on this roster and cannot be adopted here.
 */
export function findSetupBotContact(value: unknown): SetupBotRef | null {
  for (const row of contactRows(value)) {
    const uid = trimmedField(row, "personUid", "uid", "agentUid");
    if (!uid || !isAgentUid(uid)) continue;
    const name = trimmedField(row, "displayName", "name");
    if (name.toLowerCase() !== SETUP_BOT_NAME) continue;
    return { agentUid: uid, name };
  }
  return null;
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

/**
 * One start at a time.
 *
 * #welcome's automatic first-open start, its Run Setup button and Home's setup
 * card all call the same `SetupBotLauncher.start()`, and each surface only
 * disables its own button — so two of them can each issue their own
 * `hq bot create setup`. The owner's VM log caught exactly that: two creates
 * 1.3 s apart, the second answered 409 by the cloud.
 *
 * Wrapping the host's start in this gate makes a second caller await the
 * first's result and receive it, instead of starting a second run. The gate
 * opens again as soon as the run settles, so Retry still works.
 */
export function singleFlightStart(
  start: () => Promise<SetupBotStart>,
): () => Promise<SetupBotStart> {
  let inFlight: Promise<SetupBotStart> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const run = start().finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  };
}

/** Label for the one primary action on #welcome / the Home setup card. */
export function setupBotActionLabel(launcher: Pick<SetupBotLauncher, "existing"> | null | undefined): string {
  return launcher?.existing ? SETUP_BOT_COPY.open : SETUP_BOT_COPY.run;
}
