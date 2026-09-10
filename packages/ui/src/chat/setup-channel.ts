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
import type { Workspace } from "./workspaces.js";

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

/** Human-facing text only. Native preflight makes the setup skill available
 * before opening Claude; recovery instructions belong in that skill. Plain
 * language works even when Claude has not registered project slash commands.
 */
export const SETUP_DEEP_LINK_PROMPT = "Run the setup skill";

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
  body: "Create or choose a company below. We'll guide you through cloud setup and choosing a plan, then open your team's channel. Already created a company on the website? Sign in with the same account to continue it here.",
} as const;

/**
 * Hero copy when the signed-in account already owns or belongs to a company
 * (created on the website, or on another machine). The welcome pane must lead
 * with THAT company — never with "Create a company" — or a brand-new owner
 * reads the app as having lost the company they just paid for.
 */
export const SETUP_HERO_RETURNING = {
  eyebrow: "Welcome to HQ",
  title: "Your company is ready.",
  body: "Run Setup connects this Mac to your company and finishes the last steps in HQ Sessions. It takes about a minute.",
} as const;

/** The one primary action on #welcome. */
export const SETUP_RUN_LABEL = "Run Setup";
/** Disclosure that holds every other way in (separate coding tools, more companies, hosted agents). */
export const SETUP_ADVANCED_LABEL = "Advanced";
export const SETUP_ADVANCED_TOOLS_NOTE = "Open setup in a separate coding tool instead of HQ Sessions:";
export const SETUP_HOSTED_AGENT_NOTE =
  "Hosted agents: open your company channel and choose Add agent, then send it a direct message. Hosted agents require a paid plan; local setup does not.";

/**
 * Boot lands on #welcome until Run Setup (or one of its advanced launches)
 * has been used once on this machine. Persisted locally, not per session:
 * a new person who quits and relaunches before running setup must land on
 * #welcome again, not in a company channel with nothing connected.
 */
export const WELCOME_SETUP_RUN_KEY = "hq.welcome.setup-run.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function welcomeStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** True once setup has been run from #welcome on this machine. */
export function hasRunWelcomeSetup(storage?: StorageLike | null): boolean {
  try {
    return welcomeStorage(storage)?.getItem(WELCOME_SETUP_RUN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Record that setup was run from #welcome; later boots open the company channel. */
export function markWelcomeSetupRun(storage?: StorageLike | null): void {
  try {
    welcomeStorage(storage)?.setItem(WELCOME_SETUP_RUN_KEY, "1");
  } catch {
    // Storage unavailable (private mode, test env): boot simply prefers #welcome again.
  }
}

/**
 * Hero copy while the shell is still fetching the roster for this session.
 * Leading with "Create or choose a company" before the roster has loaded
 * once is exactly how a brand-new owner was told their website-created
 * company did not exist.
 */
export const SETUP_HERO_LOADING = {
  eyebrow: SETUP_HERO.eyebrow,
  title: SETUP_HERO.title,
  body: "Loading your workspace…",
} as const;

/** Where the shell is in loading the company roster for this session. */
export type SetupRosterStatus = "loading" | "ready" | "failed";

/** Copy for the roster-failed line under the hero. */
export const SETUP_ROSTER_FAILED = {
  body: "Couldn’t load your companies.",
  retry: "Retry",
} as const;

/**
 * True while the roster has not loaded once for this session. A roster that
 * already holds a company (from an earlier load) is never "loading" here — a
 * later refresh must not flip the hero back to a spinner. A host that does
 * not report a status (fixtures, classic surfaces) is treated as ready.
 */
export function setupRosterLoading(
  companies: readonly Workspace[] | null | undefined,
  status: SetupRosterStatus | null | undefined,
): boolean {
  return status === "loading" && setupCompanies(companies).length === 0;
}

/** Pick the hero copy for the roster the shell currently knows about. */
export function setupHeroFor(
  companies: readonly Workspace[] | null | undefined,
  status: SetupRosterStatus | null | undefined = null,
): typeof SETUP_HERO | typeof SETUP_HERO_RETURNING | typeof SETUP_HERO_LOADING {
  if (setupCompanies(companies).length > 0) return SETUP_HERO_RETURNING;
  return setupRosterLoading(companies, status) ? SETUP_HERO_LOADING : SETUP_HERO;
}

/**
 * Company workspaces from the roster, regardless of sync state or whether a
 * local folder exists yet. A cloud-only, pending, or broken company is still
 * a company the user has — it is the thing #welcome must point at.
 */
export function setupCompanies(
  companies: readonly Workspace[] | null | undefined,
): Workspace[] {
  return (companies ?? []).filter((company) => company.kind === "company");
}

/** Plain-language display name for a roster row (never a uid or slug id). */
export function setupCompanyName(company: Workspace): string {
  const name = company.displayName?.trim();
  if (name) return name;
  return company.slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Primary action label for a company on #welcome. A company that already has
 * a synced local folder is simply opened; anything else (cloud-only, pending
 * invite, broken mapping) still has setup to finish.
 */
export function setupCompanyActionLabel(company: Workspace): string {
  const name = setupCompanyName(company);
  const settled =
    company.state === "synced" &&
    company.hasLocalFolder &&
    company.membershipStatus !== "pending";
  return settled ? `Open ${name}` : `Continue setup for ${name}`;
}

/**
 * Hide the seeded `create_company` lifecycle card from the #welcome timeline
 * once the roster shows a company. The seeded card is stamped for every new
 * account before the server knows about the website-created company, so
 * without this filter the pane leads with "Create a company" for an owner
 * who already has one. It comes back the moment the user asks for another
 * company (`createRequested`), whether the server posts a fresh card or the
 * seeded one is reused.
 */
export function withoutSeededCreateCompanyCards<
  T extends { systemEvent?: unknown },
>(
  messages: readonly T[],
  options: {
    hasCompany: boolean;
    createRequested: boolean;
    /** Roster not loaded once yet: the seeded card must wait for it. */
    rosterLoading?: boolean;
  },
): T[] {
  if (options.createRequested) return messages.slice();
  if (!options.hasCompany && !options.rosterLoading) return messages.slice();
  return messages.filter((message) => !isCreateCompanyCard(message.systemEvent));
}

/**
 * #welcome has one job (Run Setup). The server-posted `companies_summary`
 * card duplicated the sidebar (the roster) and the company channel (its
 * lifecycle steps) as a chat message that scrolled, aged, and out-shouted
 * the hero. It is never rendered on #welcome; "Create another company"
 * lives under the hero's Advanced disclosure and still runs the same action.
 */
export function withoutCompaniesSummaryCards<
  T extends { systemEvent?: unknown },
>(messages: readonly T[]): T[] {
  return messages.filter((message) => !isCompaniesSummaryCard(message.systemEvent));
}

function isCompaniesSummaryCard(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const event = raw as { type?: unknown; kind?: unknown };
  return event.type === "lifecycle_card" && event.kind === "companies_summary";
}

function isCreateCompanyCard(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const event = raw as { type?: unknown; kind?: unknown };
  return event.type === "lifecycle_card" && event.kind === "create_company";
}

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
    body: "Create or choose a company below, follow the setup steps, and open its team channel. Starter is free; paid agents are optional.",
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

/**
 * What the #welcome native run sends. `--guided` tells the /setup skill it is
 * driving the desktop card: emit step markers and the guided cards (found /
 * integrations / secret) instead of the terminal-only flows (e.g. a one-time
 * secret link). Terminal launches keep the plain prompt above.
 */
export const SETUP_GUIDED_PROMPT = "/setup --guided";
