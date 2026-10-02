/**
 * Turns a cloud bot's setup status into what a setup card shows.
 *
 * Input: `setupState` + `nextActions` + `chatReady` from
 * GET /v1/agents/{uid}/status (or the `{agent, setupState}` a create returns).
 * Output: four plain-language stages, the actions to render, and whether the
 * chat can be used yet.
 *
 * The server is the only place that decides which actions exist. This module
 * renders `nextActions` as sent, drops kinds it does not know, and only works
 * actions out for itself when the server predates `nextActions` (the field is
 * absent): a device code from `pairing`, or a Retry for a failed step.
 */

import {
  AGENT_BRAINS,
  NEXT_ACTION_KINDS,
  type AgentBrain,
  type AgentCreateResponse,
  type AgentPairing,
  type AgentSetupPhase,
  type AgentSetupStep,
  type AgentStatusResponse,
  type NextAction,
  type NextActionKind,
  type SyncInProgressAction,
} from "./types.js";

export type SetupGroupId = "computer" | "signin" | "files" | "checks";
export type SetupGroupStatus = "pending" | "active" | "waiting" | "failed" | "done";

export interface SetupGroupView {
  id: SetupGroupId;
  label: string;
  status: SetupGroupStatus;
}

/**
 * - `working`: setup is running and nothing is asked of the person.
 * - `needs_action`: a required action is waiting on the person.
 * - `failed`: a step failed; `failure` says which and the actions offer Retry.
 * - `ready`: every step is done.
 * - `removed`: the bot is being or has been deprovisioned.
 */
export type SetupStage = "working" | "needs_action" | "failed" | "ready" | "removed";

export interface SetupView {
  phase: AgentSetupPhase;
  stage: SetupStage;
  /** The bot can reply in chat (may be true before `ready`). */
  chatReady: boolean;
  ready: boolean;
  groups: SetupGroupView[];
  /** Actions to render, required first. Unknown kinds are left out. */
  actions: NextAction[];
  /** The first required action, if any: the one thing the person should do. */
  primaryAction: NextAction | null;
  /** Informational sync progress, shown as a line, never as a button. */
  sync: SyncInProgressAction | null;
  failure: { step: string; reason: string | null } | null;
}

const GROUP_OF_STEP: Record<string, SetupGroupId> = {
  identity: "computer",
  membership: "computer",
  vault: "computer",
  runtime: "computer",
  channels: "computer",
  "runtime-install": "computer",
  "codex-auth": "signin",
  sync: "files",
  audit: "checks",
};

const GROUP_ORDER: readonly SetupGroupId[] = ["computer", "signin", "files", "checks"];

/** Plain words for a setup step name, for failure lines. */
export const STEP_LABELS: Readonly<Record<string, string>> = {
  identity: "creating the bot's identity",
  membership: "adding the bot to the company",
  vault: "setting up the bot's files",
  runtime: "starting the bot's computer",
  "codex-auth": "model sign-in",
  sync: "the first file sync",
  channels: "connecting channels",
  audit: "final checks",
  "runtime-install": "installing the bot's runtime",
};

export function stepLabel(step: string): string {
  return STEP_LABELS[step] ?? step.replace(/[-_]+/g, " ");
}

function groupLabel(id: SetupGroupId, botName: string): string {
  switch (id) {
    case "computer":
      return `Creating ${botName}'s computer`;
    case "signin":
      return "Sign in";
    case "files":
      return `Getting ${botName}'s files`;
    case "checks":
      return "Final checks";
  }
}

function foldGroup(steps: readonly AgentSetupStep[]): SetupGroupStatus {
  if (steps.length === 0) return "pending";
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "waiting")) return "waiting";
  if (steps.every((s) => s.status === "done")) return "done";
  if (steps.some((s) => s.status === "running" || s.status === "done")) return "active";
  return "pending";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function brainOf(value: unknown): AgentBrain | undefined {
  return AGENT_BRAINS.includes(value as AgentBrain) ? (value as AgentBrain) : undefined;
}

/**
 * Validate the server's `nextActions`. An entry with an unknown kind, or
 * missing the fields its kind needs, is dropped rather than half-rendered.
 */
export function parseNextActions(raw: unknown): NextAction[] {
  if (!Array.isArray(raw)) return [];
  const out: NextAction[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    const kind = rec?.kind as NextActionKind | undefined;
    const id = str(rec?.id);
    if (!rec || !id || !kind || !NEXT_ACTION_KINDS.includes(kind)) continue;
    const base = {
      id,
      required: rec.required === true,
      title: str(rec.title) ?? "",
    };
    const brain = brainOf(rec.brain);
    switch (kind) {
      case "brain_signin_device": {
        const url = str(rec.url);
        const code = str(rec.code);
        if (!url || !code) continue;
        out.push({
          ...base,
          kind,
          url,
          code,
          ...(brain ? { brain } : {}),
          ...(str(rec.expiresAt) ? { expiresAt: str(rec.expiresAt) } : {}),
        });
        break;
      }
      case "brain_signin_paste": {
        const url = str(rec.url);
        if (!url) continue;
        out.push({ ...base, kind, url, ...(brain ? { brain } : {}) });
        break;
      }
      case "plan_upgrade":
        out.push({
          ...base,
          kind,
          ...(str(rec.requiredPlan) ? { requiredPlan: str(rec.requiredPlan) } : {}),
          ...(str(rec.checkoutUrl) ? { checkoutUrl: str(rec.checkoutUrl) } : {}),
          ...(typeof rec.amountMinor === "number" ? { amountMinor: rec.amountMinor } : {}),
          ...(str(rec.currency) ? { currency: str(rec.currency) } : {}),
        });
        break;
      case "retry":
        out.push({
          ...base,
          kind,
          ...(str(rec.step) ? { step: str(rec.step) } : {}),
          ...(str(rec.reason) ? { reason: str(rec.reason) } : {}),
        });
        break;
      case "sync_in_progress": {
        const progress = asRecord(rec.progress);
        out.push({
          ...base,
          // Informational by contract: it never blocks ready.
          required: false,
          kind,
          ...(progress
            ? {
                progress: {
                  ...(typeof progress.done === "number" ? { done: progress.done } : {}),
                  ...(typeof progress.total === "number" ? { total: progress.total } : {}),
                  ...(str(progress.label) ? { label: str(progress.label) } : {}),
                },
              }
            : {}),
        });
        break;
      }
    }
  }
  return out;
}

/** The brain a bot thinks with, from its model (`codexModel`). */
export function brainOfAgent(agent: { codexModel?: unknown } | null | undefined): AgentBrain {
  const model = typeof agent?.codexModel === "string" ? agent.codexModel.toLowerCase() : "";
  if (model.startsWith("claude")) return "claude";
  if (model.startsWith("grok")) return "grok";
  return "codex";
}

/**
 * Actions for a server that does not send `nextActions` yet. Mirrors what the
 * CLI and console work out today: a sign-in from `pairing`, a Retry for a
 * failed step.
 */
function derivedActions(
  steps: readonly AgentSetupStep[],
  phase: AgentSetupPhase,
  pairing: AgentPairing | null | undefined,
  brain: AgentBrain,
  botName: string,
): NextAction[] {
  const actions: NextAction[] = [];
  const signInStep = steps.find((s) => s.name === "codex-auth");
  const url = str(pairing?.url);
  if (signInStep && signInStep.status !== "done" && url) {
    const code = str(pairing?.code);
    const title = `Sign in so ${botName} can think`;
    if (brain === "claude") {
      actions.push({ id: "brain-signin:claude", kind: "brain_signin_paste", required: true, title, url, brain });
    } else if (code) {
      actions.push({ id: `brain-signin:${brain}`, kind: "brain_signin_device", required: true, title, url, code, brain });
    }
  }
  if (phase === "failed") {
    const failed = steps.find((s) => s.status === "failed");
    actions.push({
      id: `retry:${failed?.name ?? "setup"}`,
      kind: "retry",
      required: true,
      title: failed ? `Setup stopped at ${stepLabel(failed.name)}` : "Setup stopped",
      ...(failed ? { step: failed.name } : {}),
      ...(str(failed?.lastError) ? { reason: str(failed?.lastError) } : {}),
    });
  }
  return actions;
}

export function reduceSetup(
  status: AgentCreateResponse | AgentStatusResponse,
  options: { botName?: string } = {},
): SetupView {
  const setupState = status.setupState;
  const steps = Array.isArray(setupState?.steps) ? setupState.steps : [];
  const phase = setupState?.phase ?? "provisioning";
  const botName =
    options.botName?.trim() ||
    str(status.agent?.profile?.displayName) ||
    str(status.agent?.name) ||
    "the bot";
  const full = status as Partial<AgentStatusResponse>;

  const groups = GROUP_ORDER.map((id) => ({
    id,
    label: groupLabel(id, botName),
    status: foldGroup(steps.filter((s) => (GROUP_OF_STEP[s.name] ?? "computer") === id)),
  }));

  const listed =
    full.nextActions === undefined
      ? derivedActions(steps, phase, full.pairing, brainOfAgent(status.agent), botName)
      : parseNextActions(full.nextActions);
  const actions = [...listed.filter((a) => a.required), ...listed.filter((a) => !a.required)];
  const sync = (actions.find((a) => a.kind === "sync_in_progress") as SyncInProgressAction | undefined) ?? null;
  const primaryAction = actions.find((a) => a.required && a.kind !== "sync_in_progress") ?? null;

  const ready = phase === "ready";
  const chatReady = typeof full.chatReady === "boolean" ? full.chatReady : ready;

  const failedStep = steps.find((s) => s.status === "failed");
  const failure =
    phase === "failed"
      ? { step: failedStep?.name ?? "setup", reason: str(failedStep?.lastError) ?? null }
      : null;

  let stage: SetupStage;
  if (phase === "deprovisioning" || phase === "deprovisioned") stage = "removed";
  else if (ready) stage = "ready";
  else if (phase === "failed") stage = "failed";
  else if (primaryAction) stage = "needs_action";
  else stage = "working";

  return { phase, stage, chatReady, ready, groups, actions, primaryAction, sync, failure };
}
