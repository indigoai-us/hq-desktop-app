/**
 * The calm, person-facing state for a newly created cloud bot.
 *
 * The server status payload has deliberately loose shape because older
 * deployments use different setupState projections. This module only derives
 * the three states the waking screen can act on, and never passes server
 * labels through to the UI.
 */

import { brainApprovalFromStatus, type BrainApproval, type BrainProvider } from "./bot-brain-approval.js";
import { AGENT_HELLO_WAIT_MS, agentChatReadiness } from "../agent-channel.js";

/**
 * US-001 recorded median create-to-audit time, measured 2026-10-01. Kept as a
 * record only. Those bots spent most of that time waiting on a person (brain
 * approval, Slack setup), so it is not how long the machine work takes and
 * must not be shown as a countdown.
 */
export const US001_MEDIAN_WAKING_ESTIMATE_MS = 1_244_000;
/**
 * Default estimate for the first stretch: from the create request until the
 * bot's computer is up and can ask for the sign-in. Fixtures can override it
 * per session. Measured 2026-10-02 on the first bot created through this
 * flow: the computer finished starting 134 seconds after the create request.
 */
export const WAKING_ESTIMATE_MS = 180_000;
/**
 * Default estimate for the second stretch: from the sign-in to a bot that can
 * chat. Measured 2026-10-02: the computer checked in 54 seconds after the
 * sign-in when only the server's once-a-minute pass was moving setup along.
 */
export const WAKING_FINISH_ESTIMATE_MS = 60_000;
export const WAKING_POLL_MS = 3_000;
/**
 * Setup only moves forward when something asks the server to re-check the
 * current step. The server does that once a minute on its own; the web
 * console's wizard asks every 12 seconds while it is open. This screen does
 * the same, so a finished sign-in is noticed in seconds.
 */
export const WAKING_NUDGE_MS = 12_000;
export const WAKING_RECONNECT_AFTER_FAILURES = 3;

export type WakingPhase = "waking" | "ready" | "failed";

export interface WakingBotSession {
  agentUid: string;
  channelId: string;
  companyUid: string;
  name: string;
  /** The brain selected at creation, used to request its current pairing only. */
  brain: BrainProvider | null;
  startedAt: number;
  estimateMs: number;
  phase: WakingPhase;
  progress: number;
  consecutiveCheckFailures: number;
  approval: BrainApproval | null;
  /** When the current approval request first appeared. */
  approvalSince?: number | null;
  /** When the brain sign-in was seen complete. The second stretch starts here. */
  signedInAt?: number | null;
  /** True once this session has asked the person to approve the brain. */
  askedApproval?: boolean;
  finishEstimateMs?: number;
  /** When the bot's setup first said it can chat. */
  chatReadyAt?: number | null;
  /** When the app asked the bot to say hello in the direct message. */
  helloAskedAt?: number | null;
  /** When the bot's first message was seen. The person is taken to chat then. */
  helloAt?: number | null;
  /** Fixtures can shorten how long the screen waits for the first message. */
  helloWaitMs?: number;
}

function helloWait(session: WakingBotSession): number {
  return Math.max(0, session.helloWaitMs ?? AGENT_HELLO_WAIT_MS);
}

/**
 * Whether the brain sign-in is finished. Two signals say so: the `codex-auth`
 * setup step is done, or the bot's machine reports `codex-auth: ok` in its
 * heartbeat. The second matters under the chat-first setup order, where the
 * step runs after the runtime install and would otherwise keep the screen
 * asking for a sign-in the machine already has. null when the payload carries
 * neither a step list nor a heartbeat (older deployments).
 */
function signInStepDone(payload: unknown): boolean | null {
  const root = record(payload);
  const agent = record(root?.agent) ?? root;
  const setup = record(root?.setupState) ?? record(agent?.setupState);
  const heartbeat = record(record(agent?.runtime)?.lastHeartbeat);
  const components = record(heartbeat?.components);
  const machineSignedIn = components ? text(components["codex-auth"]) === "ok" : null;
  if (machineSignedIn) return true;
  const steps = setup?.steps;
  if (!Array.isArray(steps)) return machineSignedIn;
  const step = steps.map(record).find((entry) => text(entry?.name) === "codex-auth");
  if (step) return text(step.status) === "done";
  return machineSignedIn;
}

function finishEstimate(session: WakingBotSession): number {
  return Math.max(1, session.finishEstimateMs ?? WAKING_FINISH_ESTIMATE_MS);
}

/**
 * Progress for the sunrise, in three bands so it never runs ahead of the
 * person: starting (8 to 50), waiting on the sign-in (held at 55), finishing
 * (60 to 94). 100 is reserved for a status that says the bot is ready.
 */
function stageProgress(session: WakingBotSession, now: number): number {
  if (session.chatReadyAt != null) return 96;
  if (session.signedInAt != null) {
    const elapsed = Math.max(0, now - session.signedInAt);
    return 60 + Math.min(34, Math.round((elapsed / finishEstimate(session)) * 34));
  }
  if (session.approval) return 55;
  return wakingProgress(session.startedAt, now, session.estimateMs);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * What the bot's own setup status says. "ready" here means the bot can chat,
 * not that every setup step is finished. The company file download can run
 * for many minutes after the sign-in; the server does that in the background
 * and the person should be talking to the bot meanwhile.
 */
function phaseFromStatus(payload: unknown): WakingPhase {
  const readiness = agentChatReadiness(payload);
  if (readiness.failed) return "failed";
  return readiness.chatReady ? "ready" : "waking";
}

/** True while the screen holds for the bot's first message. */
export function awaitingHello(session: WakingBotSession): boolean {
  return session.phase === "waking" && session.chatReadyAt != null && session.helloAt == null;
}

export function wakingProgress(
  startedAt: number,
  now: number = Date.now(),
  estimateMs: number = WAKING_ESTIMATE_MS,
): number {
  const elapsed = Math.max(0, now - startedAt);
  // The first stretch stops at 50: the sign-in and the finishing work are
  // still ahead, and a sun that is already up would say otherwise.
  return Math.min(50, Math.max(8, 8 + Math.round((elapsed / estimateMs) * 42)));
}

export function beginWakingSession(input: {
  agentUid: string;
  channelId: string;
  companyUid: string;
  name: string;
  brain?: BrainProvider | null;
  now?: number;
  estimateMs?: number;
}): WakingBotSession {
  const startedAt = input.now ?? Date.now();
  const estimateMs = Math.max(1, input.estimateMs ?? WAKING_ESTIMATE_MS);
  return {
    agentUid: input.agentUid.trim(),
    channelId: input.channelId.trim(),
    companyUid: input.companyUid.trim(),
    name: input.name.trim() || "Your bot",
    brain: input.brain ?? null,
    startedAt,
    estimateMs,
    phase: "waking",
    progress: wakingProgress(startedAt, startedAt, estimateMs),
    consecutiveCheckFailures: 0,
    approval: null,
    approvalSince: null,
    signedInAt: null,
    askedApproval: false,
  };
}

export function applyWakingStatus(
  session: WakingBotSession,
  payload: unknown,
  now: number = Date.now(),
): WakingBotSession {
  const statusPhase = phaseFromStatus(payload);
  const stepDone = signInStepDone(payload);
  let signedInAt = session.signedInAt ?? null;
  let chatReadyAt = session.chatReadyAt ?? null;
  let phase = statusPhase;
  if (statusPhase === "ready") {
    chatReadyAt ??= now;
    signedInAt ??= now;
    // A bot that can chat has not yet shown that it answers. The person is
    // taken to the conversation once its first message is there, or after a
    // bounded wait so a slow first answer never strands them here.
    const spoke = session.helloAt != null;
    if (!spoke && now - chatReadyAt < helloWait(session)) phase = "waking";
  }
  let approval = statusPhase === "waking" ? brainApprovalFromStatus(payload) : null;
  if (statusPhase === "waking") {
    if (stepDone === true) {
      approval = null;
      signedInAt ??= now;
    } else if (!approval && session.approval) {
      if (stepDone === false) {
        // The server reads the code from the bot's computer on a best-effort
        // basis and answers "none" when that read fails. The sign-in is not
        // finished, so the request stays on screen.
        approval = session.approval;
      } else {
        // No step list to check against: a request that went away was approved.
        signedInAt ??= now;
      }
    }
  }
  const next: WakingBotSession = {
    ...session,
    phase,
    approval,
    approvalSince: approval ? session.approvalSince ?? now : null,
    signedInAt,
    chatReadyAt,
    askedApproval: session.askedApproval === true || session.approval !== null || approval !== null,
    consecutiveCheckFailures: 0,
  };
  return { ...next, progress: phase === "ready" ? 100 : stageProgress(next, now) };
}

/** The app has sent the bot its request to say hello. */
export function recordWakingHelloAsked(
  session: WakingBotSession,
  now: number = Date.now(),
): WakingBotSession {
  return { ...session, helloAskedAt: session.helloAskedAt ?? now };
}

/** The bot's first message is in the conversation: hand the person over. */
export function recordWakingHello(
  session: WakingBotSession,
  now: number = Date.now(),
): WakingBotSession {
  return {
    ...session,
    chatReadyAt: session.chatReadyAt ?? now,
    helloAt: session.helloAt ?? now,
    phase: "ready",
    approval: null,
    approvalSince: null,
    progress: 100,
    consecutiveCheckFailures: 0,
  };
}

export function recordWakingCheckFailure(
  session: WakingBotSession,
  now: number = Date.now(),
): WakingBotSession {
  return {
    ...session,
    progress: stageProgress(session, now),
    consecutiveCheckFailures: session.consecutiveCheckFailures + 1,
  };
}

export function wakingStatusLine(
  session: WakingBotSession,
  now: number = Date.now(),
): string {
  if (session.phase === "failed") return "We couldn't start this bot.";
  if (session.phase === "ready") return `${session.name} is live. Opening chat…`;
  if (session.approval) return "One thing from you.";
  if (session.consecutiveCheckFailures >= WAKING_RECONNECT_AFTER_FAILURES) {
    return "Reconnecting. Your bot is still waking up.";
  }
  if (session.chatReadyAt != null) return `Almost there. ${session.name} is writing its first message to you.`;
  const signedIn = session.signedInAt != null;
  const since = signedIn ? session.signedInAt! : session.startedAt;
  const estimateMs = signedIn ? finishEstimate(session) : session.estimateMs;
  const lead = signedIn ? (session.askedApproval ? "You're signed in. " : "") + "Finishing up." : "Starting up.";
  if (now - since > estimateMs) {
    return signedIn
      ? `${lead} This is taking longer than usual. You can leave and come back anytime.`
      : "This is taking longer than usual. You can leave and come back anytime.";
  }
  const remainingSeconds = Math.max(1, Math.ceil((estimateMs - (now - since)) / 1000));
  const minutes = Math.ceil(remainingSeconds / 60);
  return `${lead} ${minutes > 1 ? `About ${minutes} minutes left.` : "About a minute left."}`;
}

/** Resume polling the same agent after the server accepts a retry request. */
export function resumeWakingSession(
  session: WakingBotSession,
  now: number = Date.now(),
): WakingBotSession {
  return {
    ...session,
    startedAt: now,
    phase: "waking",
    progress: session.signedInAt != null ? 60 : wakingProgress(now, now, session.estimateMs),
    consecutiveCheckFailures: 0,
    approvalSince: null,
    signedInAt: session.signedInAt != null ? now : null,
    chatReadyAt: null,
  };
}
