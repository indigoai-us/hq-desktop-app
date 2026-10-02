/**
 * The calm, person-facing state for a newly created cloud bot.
 *
 * The server status payload has deliberately loose shape because older
 * deployments use different setupState projections. This module only derives
 * the three states the waking screen can act on, and never passes server
 * labels through to the UI.
 */

import { brainApprovalFromStatus, type BrainApproval, type BrainProvider } from "./bot-brain-approval.js";

/**
 * US-001 recorded median create-to-audit time, measured 2026-10-01. Kept as a
 * record only. Those bots spent most of that time waiting on a person (brain
 * approval, Slack setup), so it is not how long the machine work takes and
 * must not be shown as a countdown.
 */
export const US001_MEDIAN_WAKING_ESTIMATE_MS = 1_244_000;
/**
 * Default estimate of the machine work, used in production; fixtures can
 * override per session. The first bot created through this flow (2026-10-02)
 * reached the approval step 49 seconds after the create request. Time the bot
 * spends waiting on the person's approval does not count against it.
 */
export const WAKING_ESTIMATE_MS = 120_000;
export const WAKING_POLL_MS = 3_000;
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
  /**
   * When the current approval request first appeared. While it is set the
   * clock is stopped: the bot is waiting on the person, not the reverse.
   */
  approvalSince?: number | null;
}

/** The moment the estimate is measured against: frozen while an approval is open. */
function wakingClock(session: WakingBotSession, now: number): number {
  return session.approvalSince ?? now;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function phaseFromStatus(payload: unknown): WakingPhase {
  const root = record(payload);
  const agent = record(root?.agent) ?? root;
  const setup = record(root?.setupState) ?? record(agent?.setupState);
  const phase = text(setup?.phase) || text(agent?.setupPhase) || text(agent?.status);
  if (/failed|error|blocked|cancelled/.test(phase)) return "failed";
  if (/ready|active|complete|online/.test(phase)) return "ready";
  return "waking";
}

export function wakingProgress(
  startedAt: number,
  now: number = Date.now(),
  estimateMs: number = WAKING_ESTIMATE_MS,
): number {
  const elapsed = Math.max(0, now - startedAt);
  // A ring that reaches 100% while work still continues falsely signals that
  // the bot is ready. Leave a visible final segment until the status says so.
  return Math.min(94, Math.max(8, Math.round((elapsed / estimateMs) * 94)));
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
  };
}

export function applyWakingStatus(
  session: WakingBotSession,
  payload: unknown,
  now: number = Date.now(),
): WakingBotSession {
  const phase = phaseFromStatus(payload);
  const approval = phase === "ready" ? null : brainApprovalFromStatus(payload);
  let startedAt = session.startedAt;
  let approvalSince = session.approvalSince ?? null;
  if (approval && approvalSince === null) {
    approvalSince = now;
  } else if (!approval && approvalSince !== null) {
    // Approved: take the time spent waiting on the person out of the elapsed
    // time, so the rest of the work is measured against the same estimate.
    startedAt += Math.max(0, now - approvalSince);
    approvalSince = null;
  }
  const next = { ...session, startedAt, approvalSince };
  return {
    ...next,
    phase,
    progress: phase === "ready" ? 100 : wakingProgress(startedAt, wakingClock(next, now), session.estimateMs),
    consecutiveCheckFailures: 0,
    approval,
  };
}

export function recordWakingCheckFailure(
  session: WakingBotSession,
  now: number = Date.now(),
): WakingBotSession {
  return {
    ...session,
    progress: wakingProgress(session.startedAt, wakingClock(session, now), session.estimateMs),
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
  if (now - session.startedAt > session.estimateMs) {
    return "This is taking longer than usual. You can close this and come back anytime.";
  }
  const remainingSeconds = Math.max(1, Math.ceil((session.estimateMs - (now - session.startedAt)) / 1000));
  const minutes = Math.ceil(remainingSeconds / 60);
  return minutes > 1 ? `About ${minutes} minutes left.` : "About a minute left.";
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
    progress: wakingProgress(now, now, session.estimateMs),
    consecutiveCheckFailures: 0,
    approvalSince: null,
  };
}
