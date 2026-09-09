// Synthetic pinned "#welcome" support channel for the live desktop shell.
//
// `setup` is the wire `channelId` the backend / Slack support bridge routes
// on — not a server-listed HQ channel until one exists. The sidebar injects
// this row client-side; the composer still sends through the standard
// channel pipeline (`send_channel_message`) with this id, and history
// fetches tolerate the channel not existing server-side yet (the adapter
// result is `{ok:false}`, which the shell already treats as "no history").
//
// This module is the shared source of truth. The classic messaging surface
// (`apps/sync/src/lib/setup-channel.ts`) re-exports from here so both
// surfaces stay in lockstep without apps/sync leaking into packages/ui.

import type { Channel } from "./channels.js";

/** Wire id the backend / Slack support bridge routes on. */
export const SETUP_CHANNEL_ID = "setup";

/**
 * What the user sees in the rail. Renamed from "setup" to "welcome" (2026-09):
 * "#setup" read like an unfinished chore rather than the place the HQ team says
 * hello.
 *
 * DISPLAY ONLY — `SETUP_CHANNEL_ID` stays "setup" because it is the wire id the
 * backend routes on and the key under which every user's history is stored. The
 * server publishes the same rename (`name: "welcome"`, legacy slug "setup"), so
 * a client on THIS version and a client on an older one address the same
 * conversation and nobody can end up holding two.
 */
export const SETUP_CHANNEL_DISPLAY_NAME = "welcome";

/** Sidebar row id for the synthetic channel (`ch:<channelId>`). */
export const SETUP_ROW_ID = `ch:${SETUP_CHANNEL_ID}`;

/** Synthetic client-side pinned channel. */
export const SETUP_CHANNEL: Channel = {
  channelId: SETUP_CHANNEL_ID,
  name: SETUP_CHANNEL_DISPLAY_NAME,
  scope: "personal",
  membership: "joined",
};

/**
 * CONFIG — launch actions on the #welcome pane. Adjust prompts here; keep
 * `grok.tool` inside the `launch_cli_in_terminal` allowlist.
 *
 * Terminal tools are interpolated into a shell by the desktop host
 * (`src-tauri/src/commands/launch.rs`, `cli_binary_for`). That allowlist is
 * currently `claude` | `codex` | `grok`. Widen the Rust match first if you
 * add another terminal tool here — the frontend constant is not the
 * security boundary.
 */
export const SETUP_LAUNCH_COMMANDS = {
  claude: { kind: "claude" as const, prompt: "/setup" },
  codex: { kind: "codex" as const, prompt: "/setup" },
  grok: { kind: "terminal" as const, tool: "grok" as const },
} as const;

/**
 * Relative path of the HQ setup wizard inside the HQ root. The deep-link
 * prompt names it so a session that cannot see the skill can still read it.
 */
export const SETUP_SKILL_PATH = ".claude/skills/setup/SKILL.md";

/**
 * HQ-root marker that tells "partially installed" apart from "never
 * downloaded". `claude_launch`'s Rust preflight keys setup repair off the
 * same file.
 */
export const SETUP_CORE_MARKER = "core/core.yaml";

/** Restores an HQ tree whose `.claude` layer is missing or damaged. */
export const SETUP_REPAIR_COMMAND = "hq rescue -y --paths .claude";

/**
 * Installs HQ into an empty folder. `hq rescue` cannot help here — it resolves
 * the HQ root and reads `core/core.yaml` for its version floor, neither of
 * which exists when the template download never landed.
 */
export const SETUP_BOOTSTRAP_COMMAND = "npx create-hq@latest .";

/**
 * Prompt used for the Claude Code Desktop DEEP LINK, which cannot use the
 * bare `/setup` slash command.
 *
 * WHY not `/setup`: Claude Desktop treats a folder handed to it by a
 * `claude://` link as untrusted, and its plugin/skill scan runs before the
 * trust dialog is accepted. HQ ships `/setup` as a project skill under
 * `.claude/skills/`, so that scan suppresses it ("skipped because this
 * workspace was not trusted when plugins were scanned") and the pre-filled
 * `/setup` lands in the composer as an unknown command. The user has to
 * accept trust and run `/reload-plugins` before the skill exists — exactly
 * the step a one-click setup CTA is supposed to remove.
 *
 * WHY a recovery ladder and not just "read the skill file": this CTA is the
 * installer's repair path. `bind_hq_root_for_setup_repair` deliberately
 * accepts any existing directory because `runSetup` reaches the ready screen
 * even when `fetch_and_extract_template` failed — the case where the HQ tree,
 * including the setup skill itself, is exactly what is missing. A prompt that
 * can only read `.claude/skills/setup/SKILL.md` dead-ends on the machines
 * that need it most, so the prompt covers all three states the folder can be
 * in: complete, partially installed, and never downloaded.
 *
 * The terminal-CLI path does NOT have the trust problem (trust is settled
 * before the scan), so `SETUP_LAUNCH_COMMANDS.claude.prompt` stays `/setup`
 * for terminal launches and clipboard copy. Only the deep link uses this.
 *
 * Must never START with `/` — a leading slash is what makes Claude parse the
 * message as a slash command in the first place.
 */
export const SETUP_DEEP_LINK_PROMPT = [
  "Set up HQ in this folder. You are running in the user's HQ root.",
  [
    `1. If ${SETUP_SKILL_PATH} exists here, read it and run the HQ setup`,
    "   wizard it describes, start to finish.",
    `2. If that file is missing but ${SETUP_CORE_MARKER} exists, the HQ files`,
    `   are incomplete — run \`${SETUP_REPAIR_COMMAND}\` here, then do step 1.`,
    "3. If neither exists, HQ never finished downloading — run",
    `   \`${SETUP_BOOTSTRAP_COMMAND}\` here to install it, then do step 1.`,
  ].join("\n"),
  "Do not wait for the /setup command to appear. Claude Desktop scans skills " +
    "before a link-opened folder is trusted, so HQ's /setup skill is usually " +
    "not registered in this session; accepting the trust dialog and then " +
    "running /reload-plugins would also make it available.",
].join("\n\n");

export type SetupLaunchCommandKey = keyof typeof SETUP_LAUNCH_COMMANDS;

export interface SetupWelcomeLink {
  label: string;
  href: string;
}

export interface SetupWelcomeMessage {
  id: string;
  title?: string;
  body: string;
  links?: readonly SetupWelcomeLink[];
}

/** Public hqforwork.com destinations the welcome experience links to. */
export const SETUP_URLS = {
  gettingStarted: "https://hqforwork.com/getting-started",
  book: "https://hqforwork.com/book",
  training: "https://hqforwork.com/training",
  docs: "https://docs.getindigo.ai",
} as const;

/** Hero copy rendered over the wallpaper at the top of #welcome. */
export const SETUP_HERO = {
  eyebrow: "Welcome to HQ",
  title: "Your team's operating system for AI.",
  body: "HQ Desktop is the companion app for the HQ team AI operating system — messaging, sync, agents, and shared files in one place. Run /setup once and your workspace is ready for your whole team.",
} as const;

export type SetupResourceKind = "guide" | "book" | "training" | "docs";

export interface SetupResource {
  id: string;
  kind: SetupResourceKind;
  /** Short uppercase label (rendered as a mono eyebrow). */
  eyebrow: string;
  title: string;
  description: string;
  href: string;
}

/**
 * Resource rows rendered beneath the hero — each opens in the system
 * browser through the host's external-link path.
 */
export const SETUP_RESOURCES: readonly SetupResource[] = [
  {
    id: "getting-started",
    kind: "guide",
    eyebrow: "Guide",
    title: "Getting started with HQ",
    description:
      "A step-by-step walkthrough from install to your first agent-run project.",
    href: SETUP_URLS.gettingStarted,
  },
  {
    id: "book",
    kind: "book",
    eyebrow: "Book",
    title: "The HQ book, free",
    description:
      "How teams run on an AI operating system — the thinking behind HQ, in one read.",
    href: SETUP_URLS.book,
  },
  {
    id: "training",
    kind: "training",
    eyebrow: "Training",
    title: "Free weekly onboarding training",
    description:
      "Join a live session with the HQ team and get your workspace set up together.",
    href: SETUP_URLS.training,
  },
  {
    id: "docs",
    kind: "docs",
    eyebrow: "Docs",
    title: "HQ Docs",
    description:
      "Commands, concepts, and reference for the rest of the HQ surface.",
    href: SETUP_URLS.docs,
  },
];

/** Closing note under the resources — this channel is a real support line. */
export const SETUP_SUPPORT_NOTE =
  "This is a support channel. Messages typed here reach the HQ team — ask anything about setup, sync, or getting your workspace running.";

/**
 * Prepopulated getting-started sequence. The classic messaging surface
 * (apps/sync SetupChannelView) renders this as chat bubbles; the live desktop
 * shell renders the richer hero + resource layout from the constants above.
 * Both derive from the same copy so they never drift.
 */
export const SETUP_WELCOME_MESSAGES: readonly SetupWelcomeMessage[] = [
  {
    id: "what-is-hq-desktop",
    title: SETUP_HERO.title,
    body: SETUP_HERO.body,
  },
  {
    id: "get-started",
    title: "How to get started",
    body: "Open your HQ folder, run /setup in Claude Code or Codex, then connect your team. The buttons below launch that prompt for you.",
    links: [
      {
        label: SETUP_RESOURCES[0].title,
        href: SETUP_URLS.gettingStarted,
      },
    ],
  },
  {
    id: "resources",
    title: "Learn HQ",
    body: "The free book, weekly live onboarding training, and the docs.",
    links: [
      { label: "The HQ book", href: SETUP_URLS.book },
      { label: "Weekly onboarding training", href: SETUP_URLS.training },
      { label: "HQ Docs", href: SETUP_URLS.docs },
    ],
  },
  {
    id: "support-channel",
    title: "This is a support channel",
    body: SETUP_SUPPORT_NOTE,
  },
];

export function isSetupChannel(id: string | null | undefined): boolean {
  return id === SETUP_CHANNEL_ID;
}

export interface WithSetupChannelOptions {
  /**
   * Epoch-ms activity stamp for the SYNTHETIC row. The constant carries no
   * activity (it is never "unread"); while pinned that is irrelevant, but an
   * UNPINNED #welcome with zero activity would sink into the collapsed
   * LAST WEEK bucket. Callers pass e.g. the start of today so it renders at
   * the bottom of TODAY instead. Ignored when a real server row wins.
   */
  activityAt?: number | null;
}

/**
 * Prepend the synthetic #welcome channel to a channels list, deduped against a
 * real server-listed `setup` channel (the real row wins — it carries server
 * unread/activity/membership). Pure; never mutates the input.
 */
export function withSetupChannel(
  channels: readonly Channel[],
  { activityAt = null }: WithSetupChannelOptions = {},
): Channel[] {
  if (channels.some((c) => isSetupChannel(c.channelId))) {
    return channels.slice();
  }
  const synthetic =
    activityAt != null && activityAt > 0
      ? { ...SETUP_CHANNEL, arrivedAt: activityAt }
      : SETUP_CHANNEL;
  return [synthetic, ...channels];
}

export interface WithSetupPinOptions {
  /**
   * The user unpinned #welcome. Persisted per tenant (see
   * `loadSetupPinDismissed`); when true the setup row id is NOT re-added and
   * is stripped if present, so the channel lists like any other row.
   */
  dismissed?: boolean;
}

/**
 * Ensure the #welcome row id is part of the pinned-id set so the rail renders
 * it in the PINNED section at the top — the default for a fresh profile.
 * Once the user unpins it (`dismissed`), it stays out of the set until they
 * pin it again. Pure; never mutates the input.
 */
export function withSetupPin(
  pins: readonly string[],
  { dismissed = false }: WithSetupPinOptions = {},
): string[] {
  if (dismissed) return pins.filter((id) => id !== SETUP_ROW_ID);
  return pins.includes(SETUP_ROW_ID) ? pins.slice() : [SETUP_ROW_ID, ...pins];
}
