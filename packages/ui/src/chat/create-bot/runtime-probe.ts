/**
 * The readiness check a local bot gets before it is saved.
 *
 * The coding tool cards used to say "Signed in" from a status read alone
 * (`agent_session_preflight`), and a bot was created on that word. An owner's
 * Codex bot was created that way and then could not answer: the person's
 * Codex config asked for a model the installed Codex was too old to run. The
 * status read was right about the sign-in and wrong about the bot.
 *
 * So before a local bot is saved, the host runs `hq bot probe`: one tiny real
 * turn with exactly the runtime, model and thinking level the bot will use.
 * The result decides the card's label and what the screen offers: sign in,
 * use a supported model, update the tool, or try again. Only a passing check
 * creates the bot. A host or hq CLI that cannot run the check falls back to
 * the status read, as before.
 *
 * Pure on purpose: every outcome's copy and actions are unit-tested without a DOM.
 */

import { DEFAULT_LOCAL_BOT_EFFORT, LOCAL_BOT_SETTINGS } from "../local-bot-settings.js";
import type { BotRuntime } from "./create-bot-model.js";

/** The classes `hq bot probe` reports, the same ones a bot's failure DM uses. */
export type ProbeClass =
  | "signed-out"
  | "cli-outdated"
  | "model-unsupported"
  | "transient"
  | "not-installed"
  | "unknown";

const PROBE_CLASSES: readonly ProbeClass[] = [
  "signed-out",
  "cli-outdated",
  "model-unsupported",
  "transient",
  "not-installed",
  "unknown",
];

/** What the flow knows about whether a bot set up this way can answer. */
export type RuntimeProbeState =
  | { state: "checking" }
  /**
   * The check passed. `createModel` is the model to create the bot with:
   * the one asked for, or the one the tool fell back to when it was too old
   * for its own default (so the bot does not hit the same wall every turn).
   */
  | { state: "ready"; createModel: string | null; fellBackFrom?: string }
  | { state: "failed"; class: ProbeClass }
  /** HQ could not run the check at all (the command failed before the tool answered). */
  | { state: "error" }
  /** This host or hq CLI cannot run the check: the status read decides, as before. */
  | { state: "unavailable" };

/** The input the host's probe takes. */
export interface RuntimeProbeInput {
  runtime: BotRuntime;
  model: string | null;
  effort: string | null;
}

/** Bots start at this thinking level, so the check runs at it too. */
export const PROBE_EFFORT = DEFAULT_LOCAL_BOT_EFFORT;

/** The check is one tiny turn; a tool that has not answered by then is reported as not answering. */
export const PROBE_TIMEOUT_SECS = 45;

/** One cache key per runtime and model, so a new model is checked on its own. */
export function probeKey(runtime: string, model: string | null | undefined): string {
  return `${runtime}|${(model ?? "").trim()}`;
}

/**
 * A model id as the hq CLI accepts it (`hq bot set --model`, `hq bot probe
 * --model`): a letter or digit, then letters, digits and `. _ : / - [ ]`, at
 * most 100 characters. The same shape the host's Rust command checks, so a
 * fallback model the CLI names (for example `opus[1m]`) is never dropped here.
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}$/;

/** Read what the host's probe answered into a state. */
export function readProbeAnswer(raw: unknown, askedModel: string | null): RuntimeProbeState {
  if (!raw || typeof raw !== "object") return { state: "error" };
  const rec = raw as Record<string, unknown>;
  if (rec.supported === false) return { state: "unavailable" };
  if (rec.ok === true) {
    const fallback = rec.modelFallback as { from?: unknown; to?: unknown } | undefined;
    const to = typeof fallback?.to === "string" ? fallback.to.trim() : "";
    if (to && MODEL_ID.test(to)) {
      const from = typeof fallback?.from === "string" ? fallback.from.trim() : "";
      return { state: "ready", createModel: to, ...(from ? { fellBackFrom: from } : {}) };
    }
    return { state: "ready", createModel: askedModel };
  }
  if (rec.ok === false) {
    // The CLI's generic failure document ({ ok: false, reason, message }) has
    // no class: the check itself did not run, so it is not the tool's verdict.
    if (typeof rec.class !== "string") return { state: "error" };
    const cls = PROBE_CLASSES.includes(rec.class as ProbeClass) ? (rec.class as ProbeClass) : "unknown";
    return { state: "failed", class: cls };
  }
  return { state: "error" };
}

/**
 * Models to try when the tool cannot run the one asked for, in order: ones
 * that have been out longest first, since an older install is the usual
 * reason. Every entry is one of the models the bot settings offer.
 */
export const SUPPORTED_MODEL_FALLBACKS: Readonly<Record<BotRuntime, readonly string[]>> = {
  codex: ["gpt-5.5"],
  claude: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"],
  grok: ["grok-4.6", "grok-4.5"],
};

/** The next model to offer for this runtime, skipping ones already tried. Null when none is left. */
export function supportedModelFor(runtime: BotRuntime, tried: readonly (string | null)[]): string | null {
  const skip = new Set(tried.map((m) => (m ?? "").trim()).filter(Boolean));
  return SUPPORTED_MODEL_FALLBACKS[runtime]?.find((m) => !skip.has(m)) ?? null;
}

/** The friendly name of a model ("GPT-5.5"), or the id itself. */
export function modelLabel(runtime: BotRuntime, model: string): string {
  return LOCAL_BOT_SETTINGS[runtime]?.models.find((m) => m.value === model)?.label ?? model;
}

/** The short status on a coding tool's card while the check runs or after it. */
export function probeCardStatus(probe: RuntimeProbeState): string | null {
  switch (probe.state) {
    case "checking":
      return "Checking...";
    case "ready":
      return "Ready";
    case "error":
      return "Couldn't check";
    case "failed":
      switch (probe.class) {
        case "signed-out":
          return "Sign in first";
        case "cli-outdated":
          return "Needs an update";
        case "model-unsupported":
          return "Model not available";
        case "not-installed":
          return "Not installed";
        default:
          return "Didn't answer";
      }
    default:
      return null;
  }
}

/** The line under the cards while the check runs. */
export function probeCheckingText(label: string): string {
  return `Checking ${label}...`;
}

/** What a failed check offers, in the order the buttons appear. */
export type ProbeAction = "signin" | "supported-model" | "update" | "install" | "retry";

export interface ProbeFix {
  text: string;
  actions: ProbeAction[];
}

export interface ProbeFixOptions {
  /** A sign-in can be opened from this screen. */
  canSignIn: boolean;
  /** HQ can install or update this tool from here. */
  canUpdate: boolean;
  /** The model "Use a supported model" would switch to, or null when none is left. */
  supportedModel: string | null;
  /** "Mac", "PC" or "computer". */
  noun?: string;
}

/**
 * The sentence and the fixes for a failed check. Plain words: never the
 * tool's own error, never a command.
 */
export function probeFix(cls: ProbeClass, label: string, opts: ProbeFixOptions): ProbeFix {
  const host = (opts.noun ?? "").trim() || "computer";
  const model = opts.supportedModel ? (["supported-model"] as ProbeAction[]) : [];
  const update = opts.canUpdate ? (["update"] as ProbeAction[]) : [];
  switch (cls) {
    case "signed-out":
      return opts.canSignIn
        ? { text: `${label} is not signed in on this ${host}. Sign in, then HQ checks again.`, actions: ["signin"] }
        : {
            text: `${label} is not signed in on this ${host}. Sign in under Settings, AI tools, then try again.`,
            actions: ["retry"],
          };
    case "cli-outdated":
      return {
        text: `${label} on this ${host} is too old for this model.${opts.supportedModel ? " Use a model it supports, or update it." : opts.canUpdate ? " Update it, then HQ checks again." : ""}`,
        actions: [...model, ...update, "retry"],
      };
    case "model-unsupported":
      return {
        text: `${label} can't use this model here.${opts.supportedModel ? " Use a model it supports." : ""}`,
        actions: [...model, "retry"],
      };
    case "not-installed":
      return {
        text: `${label} isn't installed on this ${host}.`,
        actions: [...(opts.canUpdate ? (["install"] as ProbeAction[]) : []), "retry"],
      };
    case "transient":
      return { text: `${label} didn't answer the check. It may be busy or offline.`, actions: ["retry"] };
    default:
      return { text: `${label} couldn't finish a test reply.`, actions: ["retry"] };
  }
}

/** Button labels for the fixes. */
export function probeActionLabel(action: ProbeAction, label: string, model: string | null, runtime: BotRuntime): string {
  switch (action) {
    case "signin":
      return "Sign in";
    case "supported-model":
      return model ? `Use ${modelLabel(runtime, model)}` : "Use a supported model";
    case "update":
      return `Update ${label}`;
    case "install":
      return `Install ${label}`;
    default:
      return "Try again";
  }
}

/** The line when HQ could not run the check at all. */
export function probeErrorText(): string {
  return "HQ couldn't run the check.";
}

/** The line when HQ's update of the tool did not finish. */
export function probeUpdateFailedText(label: string): string {
  return `Couldn't update ${label}. Try again.`;
}

/** The line for a passing check that had to fall back to an older model. */
export function probeFallbackText(label: string, runtime: BotRuntime, model: string): string {
  return `${label} here can't run its usual model, so this bot will use ${modelLabel(runtime, model)}.`;
}

/** The footer line when Create was pressed and the check did not pass. */
export function probeBlockedIssue(label: string): string {
  return `${label} needs a fix before this bot can be created.`;
}
