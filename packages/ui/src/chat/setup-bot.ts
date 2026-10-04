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
 * sentences: the plan, and that it is checking the person's Mac/PC/computer
 * now and may take a minute (the first model turn is slow, so say so up
 * front), plus a pointer to the Launch button for people who prefer Claude
 * Code or Codex; never an open "what would you like to do?", because the
 * kickoff turn below follows it automatically. Keep it under 500 characters
 * (the CLI's `--intro` limit) and on one line (the host rejects control
 * characters).
 *
 * The `noun` is the plain-language name for the host machine ("Mac", "PC",
 * or "computer") from `hostComputerNoun`. Missing means the probe was not
 * ready or is unknown, in which case the neutral "computer" is used so a
 * Windows user never reads "your Mac".
 */
export function setupBotIntro(
  opts: { noun?: string; displayName?: string | null } = {},
): string {
  const noun = opts.noun?.trim() || "computer";
  const intro =
    "Hi, I'm your setup bot, and together we'll get HQ ready: your tools, HQ Cloud, your company, " +
    "the work you already have, your business and the apps you use, and your first bot. " +
    `I'm checking your ${noun} now, which can take a minute, and I'll post my first question here as soon as I'm done. ` +
    "If you'd rather, you can run me in Claude Code or Codex with the Launch button above.";
  const name = opts.displayName?.trim();
  if (!name) return intro;
  return intro.replace("Hi, I'm your setup bot", `Hi, I'm ${name}, your setup bot`);
}

/**
 * The names a new setup bot is given, one picked at random. Short, friendly,
 * letters only (the CLI's `--display-name` rules), and none of them a common
 * first name, so a bot is never mistaken for a teammate.
 */
export const SETUP_BOT_NAMES: readonly string[] = [
  "Pickles", "Biscuit", "Mochi", "Waffles", "Noodle", "Pip", "Bean", "Nugget", "Sprout", "Pudding",
  "Muffin", "Dumpling", "Pretzel", "Sprinkles", "Tater", "Bubbles", "Gizmo", "Widget", "Doodle", "Toast",
  "Churro", "Cupcake", "Marshmallow", "Peanut", "Pebble", "Button", "Clover", "Maple", "Hazel", "Juniper",
  "Olive", "Pumpkin", "Taco", "Nacho", "Bagel", "Scone", "Crumpet", "Truffle", "Fudge", "Cocoa",
  "Snickers", "Tofu", "Wasabi", "Ginger", "Nutmeg", "Paprika", "Cheddar", "Brie", "Gouda", "Pesto",
  "Zippy", "Bloop", "Boop", "Wiggles", "Squiggle", "Doodlebug", "Pogo", "Yoyo", "Kazoo", "Banjo",
  "Pixel", "Sparky", "Rocket", "Comet", "Nova", "Cosmo", "Orbit", "Moonpie", "Stardust", "Nimbus",
  "Puddle", "Whisker", "Fuzzy", "Fluffy", "Scooter", "Skipper", "Bumble", "Hopper", "Waddles", "Nibbles",
  "Jellybean", "Gumdrop", "Lollipop", "Taffy", "Honeybun", "Cinnamon", "Popcorn", "Meatball", "Pancake", "Tamale",
  "Kiwi", "Mango", "Papaya", "Coconut", "Lychee", "Radish", "Turnip", "Parsnip", "Beanie", "Tidbit",
] as const;

/** Every name already used by a bot on this person's roster, lowercased. */
export function takenBotNames(contacts: unknown, extra: Iterable<string> = []): Set<string> {
  const taken = new Set<string>();
  for (const row of contactRows(contacts)) {
    const uid = trimmedField(row, "personUid", "uid", "agentUid");
    if (!uid || !isAgentUid(uid)) continue;
    const name = trimmedField(row, "displayName", "name");
    if (name) taken.add(name.toLowerCase());
  }
  for (const name of extra) if (name.trim()) taken.add(name.trim().toLowerCase());
  return taken;
}

/**
 * A name for a new setup bot that no bot the person can see already uses, so
 * two bots in one company never share one. Random among the free names; when
 * all of them are taken, the least likely clash gets a number ("Pickles 2").
 */
export function pickSetupBotName(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  const free = SETUP_BOT_NAMES.filter((name) => !taken.has(name.toLowerCase()));
  const pool = free.length > 0 ? free : SETUP_BOT_NAMES;
  const base = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
  if (free.length > 0) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

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
 *
 * The `noun` is the plain-language name for the host machine ("Mac", "PC",
 * or "computer"). Neutral fallback when the probe is not ready.
 */
export function setupBotKickoff(opts: { noun?: string } = {}): string {
  const noun = opts.noun?.trim() || "computer";
  return (
    `${SETUP_BOT_KICKOFF_PREFIX} setup has just started and your hello already went out, naming the plan and saying you are checking the ${noun} now, ` +
    "so do not greet again or repeat the plan. " +
    "First work out where this HQ stands, quietly: read your setup-progress.md note if there is one, " +
    "check whether I am signed in to HQ Cloud and as whom, whether this HQ has a company, and which of the tools HQ leans on are missing. " +
    "Then, exactly as your instructions for the kickoff say, do the part of the tools step you can do yourself, " +
    "tell me in one line what you found or fixed, and ask whether I want HQ explained first or to jump straight in, " +
    "in the exact words your instructions give; that is the one concrete question this message ends with. " +
    "After I answer, begin the first unfinished step, ending each message with exactly one concrete question or one concrete action for me. " +
    "If setup is already finished, say so in one line and offer two or three concrete next moves drawn from this HQ, then ask which to start. " +
    "Never end with an open question like \"what would you like to do?\""
  );
}

/** Static labels in the setup-bot copy that never change with the host OS. */
export const SETUP_BOT_COPY_STATIC = {
  /**
   * Create it and open the conversation. The bot normally starts by itself on
   * first open, so by the time anyone reads this button its hello is already
   * waiting: the label says what the click does, which is open it.
   */
  run: "Open Setup Agent",
  /** One already exists: this only opens the conversation. */
  open: "Open Setup Agent",
  /** Home's setup card, where "Run Setup" would not say what happens. */
  create: "Create your setup bot",
  /** While the CLI is provisioning. */
  starting: "Starting…",
  /** The bot is being started automatically on first open. */
  autoStarting: "Starting your setup bot…",
  /** Under the hero once the bot exists. */
  bodyExisting:
    "Your setup bot is in your messages. Open the conversation to keep going - it picks up wherever you left off.",
  /** After a failed create. */
  retry: "Retry",
  /** The way through when creating the bot will not work right now. */
  fallback: "Use the step-by-step setup instead",
} as const;

/**
 * Hero + button copy for the setup-bot path. `noun` is "Mac", "PC", or
 * "computer" from `hostComputerNoun`; neutral fallback when the probe is
 * not ready.
 */
export function setupBotCopy(opts: { noun?: string } = {}): typeof SETUP_BOT_COPY_STATIC & {
  cardBody: string;
  bodyStarting: string;
  body: string;
} {
  const noun = opts.noun?.trim() || "computer";
  return {
    ...SETUP_BOT_COPY_STATIC,
    /** Home's setup card, in place of "open your agent and run /setup". */
    cardBody: `Your HQ folder isn't ready yet. Your setup bot finishes it for you - it runs on this ${noun} under your own coding tool login.`,
    /** Under the hero while the automatic start runs. */
    bodyStarting: `Your setup bot is starting on this ${noun}. Its conversation opens by itself in a moment.`,
    /** Under the hero, before the first click. */
    body:
      `Setup happens in a conversation with your setup bot. It runs on this ${noun} under your own coding tool login, ` +
      "walks you through getting started, and stays afterwards for anything you need.",
  };
}

/**
 * No coding tool is signed in, so the CLI cannot start a bot. The wording is
 * purpose-first (why the person is stuck) and does NOT list three tool names
 * to someone who has just installed one — the install-guide panel that
 * renders below this line is the one place that names the specific tool.
 * `noun` is "Mac", "PC", or "computer"; neutral fallback when the probe is
 * not ready.
 *
 * Kept as an English string (rather than a string tag) so `isSetupBotNoRuntimeMessage`
 * can still recognise a value returned by an older host without a protocol
 * change; matching happens against a stable prefix, not the full sentence.
 */
export function setupBotNoRuntime(opts: { noun?: string } = {}): string {
  const noun = opts.noun?.trim() || "computer";
  // No "Sign in above, then Retry": the sign-in panel sits below this line,
  // and it notices the sign-in by itself and offers Continue.
  return `HQ needs a coding tool signed in on this ${noun} to finish setup.`;
}

/**
 * True when a message is the "no signed-in coding tool" error in any of the
 * noun variants ("this Mac" / "this PC" / "this computer"). Surfaces that
 * decide to show the guided install path use this instead of an exact match
 * against `SETUP_BOT_NO_RUNTIME`, so a Mac-noun message from
 * `setupBotNoRuntime({ noun })` still triggers the guide.
 *
 * Recognises both the new plain-language wording ("HQ needs a coding tool
 * signed in on this …") and the legacy dead-end wording ("No coding tool is
 * signed in on this …") so a host still running an older shell keeps working.
 */
export function isSetupBotNoRuntimeMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return (
    msg.startsWith("HQ needs a coding tool signed in on this") ||
    msg.startsWith("No coding tool is signed in on this")
  );
}

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

/**
 * Neutral snapshots of the OS-aware copy. Callers that render the copy for a
 * person MUST use the functions above (which take the resolved host noun);
 * these consts are here for tests and for the rare non-render call site that
 * just needs a stable literal.
 */
export const SETUP_BOT_INTRO = setupBotIntro();
export const SETUP_BOT_KICKOFF = setupBotKickoff();
export const SETUP_BOT_COPY = setupBotCopy();
export const SETUP_BOT_NO_RUNTIME = setupBotNoRuntime();

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
  return launcher?.existing ? SETUP_BOT_COPY_STATIC.open : SETUP_BOT_COPY_STATIC.run;
}

/** The HQ console on the web: team, billing, bots and settings. */
export const SETUP_BOT_CONSOLE_URL = "https://hq.computer";


/** Copy for the finish card under the setup bot's last message. */
export const SETUP_BOT_FINALE_COPY = {
  eyebrow: "Setup complete",
  title: "You're set up.",
  toolsLead: "Keep working in the coding tool you already use. It opens your HQ folder, ready to go.",
  claude: "Open in Claude Code",
  codex: "Open in Codex",
  consoleLead: "Manage your team, billing and bots from the HQ console on the web.",
  console: "Open the HQ console",
  slackLead: "Want to talk to your bot where your team already works? A Slack bot needs the Workforce plan.",
  /** Button label; `{name}` is the bot's name. */
  slack: "Put {name} in Slack",
  dismiss: "Dismiss",
} as const;

/** The finish card's Slack button label, and the message it sends the bot. */
export function setupSlackOfferText(displayName: string | null | undefined): string {
  return SETUP_BOT_FINALE_COPY.slack.replace("{name}", displayName?.trim() || "my setup bot");
}

/**
 * Did the setup bot offer a Slack bot on its finish (`setupDone` with
 * `slackAgent: true`)? The bot only sets it for someone who started their own
 * company, never for a person who joined one. Pure.
 */
export function setupFinaleOffersSlack(
  messages: ReadonlyArray<{ fromPersonUid?: string | null; body?: string | null; richContent?: unknown }>,
  botUid: string,
  offersSlack: (message: { body?: string | null; richContent?: unknown }) => boolean,
): boolean {
  const uid = botUid.trim();
  if (!uid) return false;
  return messages.some((m) => (m.fromPersonUid ?? "").trim() === uid && offersSlack(m));
}

/**
 * Should the setup finish card show under this conversation? Pure.
 *
 * True once the setup bot has sent the `setupDone` block, and only until the
 * person writes again. The card is the close of setup; a follow-up means the
 * conversation carried on, and the card would otherwise sit under every later
 * message. Only the bot's first `setupDone` counts, so a bot that repeats the
 * block later does not bring the card back.
 *
 * `messages` is the timeline, oldest first.
 */
export function setupFinaleDue(
  messages: ReadonlyArray<{ fromPersonUid?: string | null; body?: string | null; richContent?: unknown }>,
  botUid: string,
  marksDone: (message: { body?: string | null; richContent?: unknown }) => boolean,
): boolean {
  const uid = botUid.trim();
  if (!uid) return false;
  const doneAt = messages.findIndex((m) => (m.fromPersonUid ?? "").trim() === uid && marksDone(m));
  if (doneAt < 0) return false;
  return !messages.slice(doneAt + 1).some((m) => (m.fromPersonUid ?? "").trim() !== uid);
}

/**
 * The suggested replies to show under the setup bot's conversation. Pure.
 *
 * Only the bot's newest message with something to read counts, and only until
 * the person writes again: a reply (typed or clicked) puts them away, and a
 * newer bot message without suggestions replaces them with nothing, so old
 * buttons never linger under a conversation that moved on. Messages with
 * nothing visible (a lone finish marker) are skipped when finding the newest.
 *
 * `messages` is the timeline, oldest first.
 */
export function setupSuggestionsDue(
  messages: ReadonlyArray<{ fromPersonUid?: string | null; body?: string | null; richContent?: unknown }>,
  botUid: string,
  hasVisibleContent: (message: { body?: string | null; richContent?: unknown }) => boolean,
  suggestionsFor: (message: { body?: string | null; richContent?: unknown }) => string[],
): string[] {
  const uid = botUid.trim();
  if (!uid) return [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if ((message.fromPersonUid ?? "").trim() !== uid) return [];
    if (!hasVisibleContent(message) && suggestionsFor(message).length === 0) continue;
    return suggestionsFor(message);
  }
  return [];
}

