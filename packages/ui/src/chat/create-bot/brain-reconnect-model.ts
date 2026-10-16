/**
 * Signing an existing cloud bot back in to its AI model.
 *
 * A cloud bot that was live can lose its model sign-in later (the ChatGPT
 * session expires, someone signs it out). The server then reports the brain
 * as `expired` in `agent.authorizedBrains`, raises a `needs-re-auth` health
 * alert, or lists a `brain_signin_*` next action. This module reads those
 * signals from GET /v1/agents/{uid}/status, and holds the state of the screen
 * that restarts the sign-in (POST /v1/agents/{uid}/reauth) and waits for it.
 *
 * On the agents-v2 runtime the server imports the finished sign-in onto the
 * bot's machine only while something reads the status route (or on a
 * ten-minute timer), so the screen keeps reading until the brain reports
 * `authorized`.
 */

import { brainApprovalFromStatus, type BrainApproval, type BrainProvider } from "./bot-brain-approval.js";
import { wakingStopFromFailure, type WakingStop } from "./waking-model.js";
import { brandMarkFor } from "../messaging/app-brand-marks.js";
import { RUNTIME_DOMAIN, type RepairCardView } from "../messaging/runtime-repair-model.js";

export const BRAIN_PRODUCT: Readonly<Record<BrainProvider, string>> = {
  codex: "ChatGPT",
  claude: "Claude",
  grok: "Grok",
};

const BRAIN_ORDER: readonly BrainProvider[] = ["codex", "claude", "grok"];

export const RECONNECT_POLL_MS = 3_000;
export const RECONNECT_NUDGE_MS = 12_000;
export const RECONNECT_POLL_FAILING_MS = 10_000;
const RECONNECT_FAILING_AFTER = 3;
const RECONNECT_STOP_AFTER_SIGNALS = 2;
export const RECONNECT_SLOW_START_MS = 90_000;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isBrain(value: unknown): value is BrainProvider {
  return value === "codex" || value === "claude" || value === "grok";
}

function agentOf(payload: unknown): Record<string, unknown> | null {
  const root = record(payload);
  return record(root?.agent) ?? root;
}

function setupOf(payload: unknown): Record<string, unknown> | null {
  const root = record(payload);
  return record(root?.setupState) ?? record(agentOf(payload)?.setupState);
}

function mainBrain(agent: Record<string, unknown> | null): BrainProvider {
  const model = text(agent?.codexModel);
  if (model.startsWith("claude")) return "claude";
  if (model.startsWith("grok")) return "grok";
  return "codex";
}

function removed(payload: unknown): boolean {
  const phase = text(setupOf(payload)?.phase);
  return phase === "deprovisioning" || phase === "deprovisioned";
}

function setupOtherwiseDone(payload: unknown): boolean {
  const steps = setupOf(payload)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return false;
  return steps
    .map(record)
    .filter((step) => text(step?.name) !== "codex-auth")
    .every((step) => text(step?.status) === "done");
}

function signInActionBrain(payload: unknown): BrainProvider | null {
  const actions = record(payload)?.nextActions;
  if (!Array.isArray(actions)) return null;
  for (const raw of actions) {
    const action = record(raw);
    const kind = action?.kind;
    if (kind !== "brain_signin_device" && kind !== "brain_signin_paste") continue;
    if (isBrain(action?.brain)) return action.brain;
    return kind === "brain_signin_paste" ? "claude" : null;
  }
  return null;
}

export function signedOutBrainFromStatus(payload: unknown): BrainProvider | null {
  if (!record(payload) || removed(payload)) return null;
  const agent = agentOf(payload);
  const main = mainBrain(agent);
  const brains = record(agent?.authorizedBrains);
  if (brains) {
    if (text(brains[main]) === "expired") return main;
    const expired = BRAIN_ORDER.find((brain) => text(brains[brain]) === "expired");
    if (expired) return expired;
  }
  if (setupOtherwiseDone(payload)) {
    const fromAction = signInActionBrain(payload);
    if (fromAction) return fromAction;
  }
  const alert = record(record(agent?.runtime)?.healthAlert);
  if (text(alert?.streakState) === "needs-re-auth") return main;
  return null;
}

export function brainSignedInFromStatus(payload: unknown, brain: BrainProvider): boolean {
  const root = record(payload);
  const agent = agentOf(payload);
  const brains = record(agent?.authorizedBrains);
  if (brains && brains[brain] !== undefined) return text(brains[brain]) === "authorized";
  const live = record(record(root?.brainSignIn ?? agent?.brainSignIn)?.[brain]);
  if (live?.signedIn === true) return true;
  const steps = setupOf(payload)?.steps;
  if (!Array.isArray(steps)) return false;
  const step = steps.map(record).find((entry) => text(entry?.name) === "codex-auth");
  return text(step?.status) === "done";
}

export function botOwnerUidFromStatus(payload: unknown): string | null {
  const owner = agentOf(payload)?.ownerUid;
  return typeof owner === "string" && owner.trim() ? owner.trim() : null;
}

export type ReconnectPhase = "idle" | "starting" | "waiting" | "done" | "failed" | "stopped";

export type ReconnectRefusal = "not-allowed" | "api-key" | "no-machine" | "other";

export interface ReconnectSession {
  agentUid: string;
  name: string;
  brain: BrainProvider;
  phase: ReconnectPhase;
  approval: BrainApproval | null;
  startedAt: number | null;
  consecutiveCheckFailures: number;
  refusal?: ReconnectRefusal | null;
  stopped?: WakingStop | null;
  stopSignals?: number;
}

export function beginReconnect(input: {
  agentUid: string;
  name: string;
  brain: BrainProvider;
}): ReconnectSession {
  return {
    agentUid: input.agentUid.trim(),
    name: input.name.trim() || "Your bot",
    brain: input.brain,
    phase: "idle",
    approval: null,
    startedAt: null,
    consecutiveCheckFailures: 0,
    refusal: null,
    stopped: null,
    stopSignals: 0,
  };
}

function approvalFor(payload: unknown, brain: BrainProvider): BrainApproval | null {
  const approval = brainApprovalFromStatus(payload);
  return approval && approval.provider === brain ? approval : null;
}

export function applyReconnectStart(
  session: ReconnectSession,
  result: unknown,
  now: number = Date.now(),
): ReconnectSession {
  const answer = record(result);
  if (answer?.ok !== true) {
    return { ...session, phase: "failed", approval: null, refusal: reconnectRefusal(result) };
  }
  const value = record(answer.value);
  if (text(value?.signIn) === "failed") {
    return { ...session, phase: "failed", approval: null, refusal: "other" };
  }
  const approval = approvalFor(value, session.brain);
  return {
    ...session,
    phase: approval ? "waiting" : "starting",
    approval,
    startedAt: now,
    consecutiveCheckFailures: 0,
    refusal: null,
    stopped: null,
    stopSignals: 0,
  };
}

export function reconnectRefusal(result: unknown): ReconnectRefusal {
  const answer = record(result);
  const code = typeof answer?.code === "string" ? answer.code.trim() : "";
  const status =
    typeof answer?.status === "number" ? answer.status : Number(code.match(/^http-(\d{3})$/i)?.[1] ?? NaN);
  if (status === 403 || /FORBIDDEN|NOT_ALLOWED|OWNER_REQUIRED/i.test(code)) return "not-allowed";
  if (/REAUTH_NOT_APPLICABLE/i.test(code)) return "api-key";
  if (/RUNTIME_NOT_PROVISIONED/i.test(code)) return "no-machine";
  return "other";
}

export function applyReconnectStatus(session: ReconnectSession, payload: unknown): ReconnectSession {
  if (session.phase !== "starting" && session.phase !== "waiting") return session;
  if (removed(payload)) {
    return { ...session, phase: "stopped", stopped: "removed", approval: null };
  }
  const base = { ...session, consecutiveCheckFailures: 0, stopSignals: 0 };
  if (brainSignedInFromStatus(payload, session.brain)) {
    return { ...base, phase: "done", approval: null };
  }
  const approval = approvalFor(payload, session.brain) ?? session.approval;
  return { ...base, phase: approval ? "waiting" : "starting", approval };
}

export function applyReconnectCheckFailure(session: ReconnectSession, result: unknown): ReconnectSession {
  const stop = wakingStopFromFailure(result);
  const failures = session.consecutiveCheckFailures + 1;
  if (!stop) return { ...session, consecutiveCheckFailures: failures, stopSignals: 0 };
  const stopSignals = (session.stopSignals ?? 0) + 1;
  if (stopSignals >= RECONNECT_STOP_AFTER_SIGNALS) {
    return { ...session, phase: "stopped", stopped: stop, approval: null, consecutiveCheckFailures: failures, stopSignals };
  }
  return { ...session, consecutiveCheckFailures: failures, stopSignals };
}

export function reconnectPolling(session: Pick<ReconnectSession, "phase">): boolean {
  return session.phase === "starting" || session.phase === "waiting";
}

export function reconnectPollDelayMs(session: Pick<ReconnectSession, "consecutiveCheckFailures">): number {
  return session.consecutiveCheckFailures >= RECONNECT_FAILING_AFTER ? RECONNECT_POLL_FAILING_MS : RECONNECT_POLL_MS;
}

export function reconnectNeedsNudge(payload: unknown): boolean {
  const phase = text(setupOf(payload)?.phase);
  return phase !== "" && phase !== "ready";
}

function refusalLine(session: ReconnectSession): string {
  switch (session.refusal) {
    case "not-allowed":
      return `Only ${session.name}'s owner can sign it back in.`;
    case "api-key":
      return `${session.name} uses an API key, not a ${BRAIN_PRODUCT[session.brain]} sign-in. Update the key in the console.`;
    case "no-machine":
      return `${session.name}'s computer isn't running, so it can't sign in yet.`;
    default:
      return "We couldn't start a fresh sign-in. Try again.";
  }
}

function stoppedLine(session: ReconnectSession): string {
  switch (session.stopped) {
    case "removing":
      return `${session.name} is being removed.`;
    case "no-access":
      return `You no longer have access to ${session.name}.`;
    case "signed-out":
      return `You're signed out of HQ. Sign in again, then try this again.`;
    default:
      return `${session.name} was removed.`;
  }
}

export function reconnectStatusLine(session: ReconnectSession, now: number = Date.now()): string {
  const product = BRAIN_PRODUCT[session.brain];
  switch (session.phase) {
    case "idle":
      return `${session.name} can't answer until it's signed back in to ${product}. Signing in again replaces the old sign-in.`;
    case "starting":
      if (session.consecutiveCheckFailures >= RECONNECT_FAILING_AFTER) return "Reconnecting. Your sign-in is still starting.";
      if (session.startedAt != null && now - session.startedAt > RECONNECT_SLOW_START_MS) {
        return "This is taking longer than usual. You can leave and come back anytime.";
      }
      return `Starting a fresh ${product} sign-in.`;
    case "waiting":
      return "One thing from you.";
    case "done":
      return `${session.name} is signed back in to ${product}.`;
    case "failed":
      return refusalLine(session);
    case "stopped":
      return stoppedLine(session);
  }
}

export function reconnectLinkAgentUid(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  const hqHost =
    host === "hq.computer" ||
    host.endsWith(".hq.computer") ||
    host === "hq.getindigo.ai";
  if (!hqHost) return null;
  const match = parsed.pathname.match(/^\/resolve\/agents\/(agt_[A-Za-z0-9]+)\/reconnect\/?$/);
  return match ? match[1] : null;
}

export function reconnectCardView(input: {
  botName: string;
  brain: BrainProvider;
  canSignIn: boolean;
  ownerName?: string | null;
}): RepairCardView {
  const bot = input.botName.trim() || "This bot";
  const owner = input.ownerName?.trim() || "its owner";
  return {
    repairClass: "signed-out",
    phase: "offered",
    art: "signed-out",
    logo: { mark: brandMarkFor(RUNTIME_DOMAIN[input.brain]) },
    title: `Signed out of ${BRAIN_PRODUCT[input.brain]}`,
    line: input.canSignIn
      ? `${bot} can't answer until you sign it back in.`
      : `${bot} can't answer until ${owner} signs it back in.`,
    mark: null,
    primaryLabel: input.canSignIn ? "Sign back in" : null,
    primaryAction: input.canSignIn ? "signIn" : null,
    secondaryLabel: null,
    secondaryAction: null,
    note: null,
  };
}

export function reconnectTargetFromStatus(payload: unknown): { name: string; brain: BrainProvider } {
  const agent = agentOf(payload);
  const profile = record(agent?.profile);
  const shown = typeof profile?.displayName === "string" ? profile.displayName.trim() : "";
  const name = shown || (typeof agent?.name === "string" ? agent.name.trim() : "");
  return { name, brain: signedOutBrainFromStatus(payload) ?? mainBrain(agent) };
}
