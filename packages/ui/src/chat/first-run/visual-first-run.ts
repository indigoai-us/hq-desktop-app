/**
 * Visual first-run setup (owner plan, 2026-10-08), slice 1.
 *
 * With `desktop.visual-first-run` on, a first run opens the New bot
 * step-through takeover instead of auto-starting the setup bot's chat. The
 * first bot IS the setup bot (it still runs the `setup` worker), named by the
 * person. The setup chat stays the fallback ("Continue in chat") and the
 * place the rest of setup happens.
 *
 * The full plan has seven screens: 1 Name your HQ assistant, 2 Your team,
 * 3 Your coding tools, 4 Bring in your context, 5 Note taker, 6 Project
 * management, 7 Done. This slice ships 1, 3 and 7. The step list below is
 * data: a later slice inserts its screen into `FIRST_RUN_STEPS` and the
 * progress bars, "Next: <step>" labels and Back follow without other edits.
 *
 * This module is pure: steps, copy, the name rule, the handoff kickoff, the
 * "never again" marker, the routing decision and the one-create-at-a-time
 * starter. `DesktopApp.svelte` hosts the takeover on top of it.
 */

import type { LocalBotRow } from "@hq/platform";

import { LOCAL_BOT_RUNTIMES } from "../local-bots.js";
import { SETUP_BOT_KICKOFF_PREFIX, SETUP_BOT_RUNTIME_ORDER, type SetupBotRef } from "../setup-bot.js";

export type FirstRunRuntime = LocalBotRow["runtime"];

/**
 * Every screen the finished flow will have. Only the ids listed in
 * `FIRST_RUN_STEPS` are shown; the rest belong to later slices.
 */
export type FirstRunStepId = "name" | "team" | "tools" | "context" | "notes" | "projects" | "done";

export interface FirstRunStep {
  id: FirstRunStepId;
  /** The step's name in "Next: <label>". */
  label: string;
}

/** The screens this build shows, in order. The last one is always Done. */
export const FIRST_RUN_STEPS: readonly FirstRunStep[] = [
  { id: "name", label: "Name your assistant" },
  { id: "tools", label: "Your coding tools" },
  { id: "done", label: "Done" },
];

function indexOfStep(id: FirstRunStepId, steps: readonly FirstRunStep[]): number {
  return steps.findIndex((step) => step.id === id);
}

/** 1-based place of a step in the progress bars; 0 when it is not shown. */
export function firstRunStepNumber(id: FirstRunStepId, steps: readonly FirstRunStep[] = FIRST_RUN_STEPS): number {
  return indexOfStep(id, steps) + 1;
}

export function nextFirstRunStep(
  id: FirstRunStepId,
  steps: readonly FirstRunStep[] = FIRST_RUN_STEPS,
): FirstRunStepId | null {
  const at = indexOfStep(id, steps);
  return at >= 0 && at + 1 < steps.length ? steps[at + 1]!.id : null;
}

export function prevFirstRunStep(
  id: FirstRunStepId,
  steps: readonly FirstRunStep[] = FIRST_RUN_STEPS,
): FirstRunStepId | null {
  const at = indexOfStep(id, steps);
  return at > 0 ? steps[at - 1]!.id : null;
}

/** "Next: Your coding tools", or "" on the last step. */
export function firstRunNextLabel(id: FirstRunStepId, steps: readonly FirstRunStep[] = FIRST_RUN_STEPS): string {
  const next = nextFirstRunStep(id, steps);
  const label = next ? steps.find((step) => step.id === next)?.label : null;
  return label ? `Next: ${label}` : "";
}

/**
 * "Finish with defaults" sits beside "Next" on every step whose next step is
 * not the last one. Next to the last step both buttons would do the same
 * thing, so the step shows only Next.
 */
export function firstRunOffersFinish(id: FirstRunStepId, steps: readonly FirstRunStep[] = FIRST_RUN_STEPS): boolean {
  const next = nextFirstRunStep(id, steps);
  return next !== null && nextFirstRunStep(next, steps) !== null;
}

/** True when at least one coding tool is signed in on this computer. */
export function anyToolReady(ready: Record<string, boolean> | null | undefined): boolean {
  return SETUP_BOT_RUNTIME_ORDER.some((runtime) => ready?.[runtime] === true);
}

/**
 * Where "Finish with defaults" lands: Done, unless a required step is still
 * open. The coding tools step is required only while no tool is ready.
 */
export function firstRunFinishTarget(
  ready: Record<string, boolean> | null | undefined,
  steps: readonly FirstRunStep[] = FIRST_RUN_STEPS,
): FirstRunStepId {
  if (!anyToolReady(ready) && indexOfStep("tools", steps) >= 0) return "tools";
  return steps[steps.length - 1]?.id ?? "done";
}

/** Whether a step lets the person move on. */
export function firstRunCanLeave(
  id: FirstRunStepId,
  ready: Record<string, boolean> | null | undefined,
): boolean {
  return id === "tools" ? anyToolReady(ready) : true;
}

// ── copy ────────────────────────────────────────────────────────────────────

export interface FirstRunTitle {
  kicker: string;
  lead: string;
  em: string;
  copy: string;
}

export const FIRST_RUN_NAME_TITLE: FirstRunTitle = {
  kicker: "Welcome to HQ",
  lead: "Name your HQ",
  em: "assistant.",
  copy: "Your assistant finishes setting up HQ with you and stays to help afterwards. Keep this name or pick your own.",
};

/** `{name}` is the assistant's name; `noun` is "Mac", "PC" or "computer". */
export function firstRunToolsTitle(name: string, noun = "computer"): FirstRunTitle {
  const shown = name.trim() || "Your assistant";
  return {
    kicker: "Your coding tools",
    lead: "Connect a",
    em: "coding tool.",
    copy: `${shown} thinks with a coding tool signed in on this ${noun}, under your own login. One is enough.`,
  };
}

export function firstRunDoneTitle(name: string): FirstRunTitle {
  const shown = name.trim() || "your assistant";
  return {
    kicker: "All set",
    lead: "Meet",
    em: `${shown}.`,
    copy: `${shown} picks up the rest of setup in chat, starting after the steps you just finished.`,
  };
}

export const FIRST_RUN_COPY = {
  /** The header's way out, on every screen. */
  continueInChat: "Continue in chat",
  finish: "Finish with defaults",
  /** Shown on the name step once the assistant is being created. */
  nameLocked: "This name is taken into setup now. You can rename your assistant later from its profile.",
  opening: "Opening…",
  retry: "Retry",
  retrying: "Retrying…",
} as const;

export function firstRunTalkLabel(name: string): string {
  return `Talk to ${name.trim() || "your assistant"}`;
}

export function runtimeLabel(runtime: FirstRunRuntime): string {
  return LOCAL_BOT_RUNTIMES.find((r) => r.id === runtime)?.label ?? runtime;
}

// ── name ────────────────────────────────────────────────────────────────────

/** `hq bot create --display-name` limit (Slack's display-name bound). */
export const ASSISTANT_NAME_MAX = 35;

/**
 * Why a name cannot be the assistant's display name, or null. The same rule
 * as the host's `validate_display_name` (apps/sync bots.rs): letters first,
 * then letters, spaces, apostrophes, periods and hyphens, at most 35.
 */
export function assistantNameIssue(name: string): string | null {
  const collapsed = name.split(/\s+/).filter(Boolean).join(" ");
  if (!collapsed) return "Give your assistant a name.";
  if ([...collapsed].length > ASSISTANT_NAME_MAX) return `Keep the name under ${ASSISTANT_NAME_MAX} characters.`;
  if (!/^\p{L}[\p{L} .'-]*$/u.test(collapsed)) return "Use letters, spaces, apostrophes, periods and hyphens.";
  return null;
}

// ── handoff ─────────────────────────────────────────────────────────────────

/** What the takeover settled, handed to the setup bot so it never asks again. */
export interface FirstRunHandoff {
  /** The assistant's display name, as the person confirmed it. */
  name: string;
  /** The coding tool the assistant runs on. */
  runtime: FirstRunRuntime;
  /** Every coding tool signed in when the assistant was created. */
  toolsReady: readonly FirstRunRuntime[];
}

/** Setup steps the takeover finished. Later slices add theirs. */
export const FIRST_RUN_SETTLED_STEPS = ["name", "codingTools"] as const;

/** The machine-readable part of the kickoff: one JSON object, one line. */
export function firstRunHandoffNote(handoff: FirstRunHandoff): string {
  return JSON.stringify({
    from: "desktop-visual-first-run",
    v: 1,
    done: FIRST_RUN_SETTLED_STEPS,
    name: handoff.name.trim(),
    runtime: handoff.runtime,
    toolsReady: [...new Set(handoff.toolsReady)],
  });
}

/** Under the CLI's `--kickoff` bound (2000) with room to spare. */
export const FIRST_RUN_KICKOFF_MAX = 1900;

/**
 * The setup bot's first task (`hq bot create --kickoff`) when it was named in
 * the takeover. Same contract as `setupBotKickoff`: starts with the prefix
 * the setup template recognises, one line, no control characters, under 2000
 * characters. It says which steps are done (the JSON handoff and the same in
 * words) so the bot skips them, and otherwise follows the usual opening.
 */
export function firstRunKickoff(handoff: FirstRunHandoff, opts: { noun?: string } = {}): string {
  const noun = opts.noun?.trim() || "computer";
  const name = handoff.name.trim();
  const tool = runtimeLabel(handoff.runtime);
  const kickoff =
    `${SETUP_BOT_KICKOFF_PREFIX} setup started in the HQ desktop app's visual setup, where I already finished some steps, ` +
    "and your hello already went out, so do not greet again or repeat the plan. " +
    `Handoff from the app: ${firstRunHandoffNote(handoff)}. ` +
    "Every step in \"done\" is settled: never ask about it again and record it as done in your setup-progress.md note. " +
    `I chose your name, ${name}, so keep it. ` +
    `The coding tool sign-in is finished: ${tool} is signed in on this ${noun} and you run on it, so do not ask me to pick or sign in to a coding tool. ` +
    "First work out where this HQ stands, quietly: read your setup-progress.md note if there is one, " +
    "check whether I am signed in to HQ Cloud and as whom, whether this HQ has a company, and whether any other tool HQ leans on is missing, and fix what you can yourself. " +
    "I chose to jump straight in, so do not ask whether I want HQ explained first. " +
    "Tell me in one line what you found or fixed, then begin the first unfinished step that is not in \"done\", " +
    "ending each message with exactly one concrete question or one concrete action for me. " +
    "If setup is already finished, say so in one line and offer two or three concrete next moves drawn from this HQ, then ask which to start. " +
    "Never end with an open question like \"what would you like to do?\"";
  // eslint-disable-next-line no-control-regex
  return kickoff.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/**
 * The same handoff for a setup bot that already existed (a reinstall, or a
 * second computer): its kickoff ran long ago, so the app sends this as a
 * bot-only message in its DM instead. Not a kickoff (no prefix): the bot
 * carries on from where it is, minus the settled steps. One line, no control
 * characters, under 2000 characters.
 */
export function firstRunHandoffNotice(handoff: FirstRunHandoff, opts: { noun?: string } = {}): string {
  const noun = opts.noun?.trim() || "computer";
  const name = handoff.name.trim();
  const tools = [...new Set(handoff.toolsReady)].map(runtimeLabel).join(", ") || runtimeLabel(handoff.runtime);
  const notice =
    "Setup note from the HQ desktop app: I just went through the app's visual setup, which finished some setup steps for you. " +
    `Handoff from the app: ${firstRunHandoffNote(handoff)}. ` +
    "Every step in \"done\" is settled: never ask about it again and record it as done in your setup-progress.md note. " +
    `I named you ${name}, so use that name. ` +
    `The coding tool sign-in is finished: signed in on this ${noun}: ${tools}. Do not ask me to pick or sign in to a coding tool. ` +
    "Do not greet me again. When I next write, carry on from the first unfinished step that is not in \"done\".";
  // eslint-disable-next-line no-control-regex
  return notice.replace(/[\u0000-\u001f\u007f]/g, " ");
}

/**
 * The bot's hello (`hq bot create --intro`, under 500 characters, one line)
 * when it was named in the takeover: it already knows its name and tool.
 */
export function firstRunIntro(handoff: Pick<FirstRunHandoff, "name" | "runtime">, opts: { noun?: string } = {}): string {
  const noun = opts.noun?.trim() || "computer";
  const name = handoff.name.trim() || "your HQ assistant";
  return (
    `Hi, I'm ${name}, your HQ assistant. You've named me and signed in ${runtimeLabel(handoff.runtime)}, so I won't ask about those again. ` +
    `I'm checking your ${noun} now, which can take a minute, and I'll post my next question here as soon as I'm done.`
  );
}

// ── never again ────────────────────────────────────────────────────────────

/**
 * Set when the person leaves the takeover through Done ("Talk to <Name>") or
 * "Continue in chat". From then on the takeover never opens again on this
 * computer, whatever the flag says.
 */
export const VISUAL_FIRST_RUN_DONE_KEY = "hq.setup.visual-first-run.done.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function firstRunStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage;
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function hasFinishedVisualFirstRun(storage?: StorageLike | null): boolean {
  try {
    return firstRunStorage(storage)?.getItem(VISUAL_FIRST_RUN_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markVisualFirstRunFinished(storage?: StorageLike | null): void {
  try {
    firstRunStorage(storage)?.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
  } catch {
    // Storage unavailable: the in-session close still holds.
  }
}

// ── routing ─────────────────────────────────────────────────────────────────

/**
 * Which first run this launch gets:
 *   "legacy"  today's path (the setup bot starts by itself in its chat), and
 *             every launch that is not a first run;
 *   "visual"  the takeover;
 *   "pending" the flag or the host's "setup owed" answer is not in yet, so
 *             nothing auto-starts until it is.
 * Flag off is "legacy" the moment the flag answers.
 */
export type FirstRunRoute = "legacy" | "visual" | "pending";

/**
 * How long the flag may still answer after the host's "setup owed" answer is
 * in. Both are read from mount, so with the flag off a first run waits at
 * most this much longer than it did before the flag existed, and not at all
 * when the flag answers first.
 */
export const VISUAL_FIRST_RUN_FLAG_GRACE_MS = 1000;

export interface FirstRunRouteInput {
  /** The host can run local bots (desktop app). */
  hasBots: boolean;
  /** Setup was already run from #welcome on this computer. */
  welcomeSetupRun: boolean;
  /** The host says this computer still owes setup; null until it answers. */
  welcomeSetupOwed: boolean | null;
  /** `desktop.visual-first-run`; null until it answers. */
  flag: boolean | null;
  /** The takeover was finished or left for chat on this computer. */
  finished: boolean;
}

export function firstRunRoute(input: FirstRunRouteInput): FirstRunRoute {
  if (!input.hasBots || input.welcomeSetupRun || input.finished) return "legacy";
  if (input.flag === null) return "pending";
  if (!input.flag) return "legacy";
  if (input.welcomeSetupOwed === null) return "pending";
  return input.welcomeSetupOwed ? "visual" : "legacy";
}

// ── creating the assistant ─────────────────────────────────────────────────

export type FirstRunAssistantResult = { ok: true; bot: SetupBotRef } | { ok: false; reason: string };

/** Where creating the assistant stands, as the takeover shows it. */
export type FirstRunCreation =
  | { state: "idle" }
  | { state: "creating"; name: string }
  | { state: "ready"; name: string; bot: SetupBotRef }
  | { state: "failed"; name: string; reason: string };

export interface FirstRunAssistantStarter {
  /**
   * Start creating the assistant under this name. A call while one is in
   * flight, or after one succeeded, does nothing: a double click or a second
   * Enter never creates a second bot. After a failure it runs again (Retry).
   */
  start(name: string): void;
  /** Run again with the last name, after a failure. */
  retry(): void;
  current(): FirstRunCreation;
}

/**
 * The single-flight creator behind the takeover. `run` creates (or adopts)
 * the setup bot; `onchange` gets every state, starting with "creating"
 * synchronously so the pending state shows on the same frame as the click.
 */
export function createFirstRunAssistantStarter(
  run: (name: string) => Promise<FirstRunAssistantResult>,
  onchange: (state: FirstRunCreation) => void,
): FirstRunAssistantStarter {
  let state: FirstRunCreation = { state: "idle" };
  let lastName = "";
  const set = (next: FirstRunCreation): void => {
    state = next;
    onchange(next);
  };
  function start(name: string): void {
    if (state.state === "creating" || state.state === "ready") return;
    const trimmed = name.trim();
    if (!trimmed) return;
    lastName = trimmed;
    set({ state: "creating", name: trimmed });
    void Promise.resolve()
      .then(() => run(trimmed))
      .then(
        (result) =>
          set(result.ok ? { state: "ready", name: trimmed, bot: result.bot } : { state: "failed", name: trimmed, reason: result.reason }),
        (err: unknown) => {
          console.warn("[hq-desktop] first-run assistant create threw:", err);
          set({ state: "failed", name: trimmed, reason: "Could not start your assistant. Please try again." });
        },
      );
  }
  return {
    start,
    retry() {
      if (state.state === "failed" && lastName) start(lastName);
    },
    current: () => state,
  };
}
