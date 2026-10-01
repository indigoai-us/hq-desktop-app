/**
 * The calm, person-facing state for a newly created cloud bot.
 *
 * The server status payload has deliberately loose shape because older
 * deployments use different setupState projections. This module only derives
 * the three states the waking screen can act on, and never passes server
 * labels through to the UI.
 */

export const WAKING_ESTIMATE_MS = 180_000;
export const WAKING_POLL_MS = 3_000;
export const WAKING_RECONNECT_AFTER_FAILURES = 3;

export type WakingPhase = "waking" | "ready" | "failed";

export interface WakingBotSession {
  agentUid: string;
  channelId: string;
  companyUid: string;
  name: string;
  startedAt: number;
  phase: WakingPhase;
  progress: number;
  consecutiveCheckFailures: number;
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

export function wakingProgress(startedAt: number, now: number = Date.now()): number {
  const elapsed = Math.max(0, now - startedAt);
  // A ring that reaches 100% while work still continues falsely signals that
  // the bot is ready. Leave a visible final segment until the status says so.
  return Math.min(94, Math.max(8, Math.round((elapsed / WAKING_ESTIMATE_MS) * 94)));
}

export function beginWakingSession(input: {
  agentUid: string;
  channelId: string;
  companyUid: string;
  name: string;
  now?: number;
}): WakingBotSession {
  const startedAt = input.now ?? Date.now();
  return {
    agentUid: input.agentUid.trim(),
    channelId: input.channelId.trim(),
    companyUid: input.companyUid.trim(),
    name: input.name.trim() || "Your bot",
    startedAt,
    phase: "waking",
    progress: wakingProgress(startedAt, startedAt),
    consecutiveCheckFailures: 0,
  };
}

export function applyWakingStatus(
  session: WakingBotSession,
  payload: unknown,
  now: number = Date.now(),
): WakingBotSession {
  const phase = phaseFromStatus(payload);
  return {
    ...session,
    phase,
    progress: phase === "ready" ? 100 : wakingProgress(session.startedAt, now),
    consecutiveCheckFailures: 0,
  };
}

export function recordWakingCheckFailure(
  session: WakingBotSession,
  now: number = Date.now(),
): WakingBotSession {
  return {
    ...session,
    progress: wakingProgress(session.startedAt, now),
    consecutiveCheckFailures: session.consecutiveCheckFailures + 1,
  };
}

export function wakingStatusLine(
  session: WakingBotSession,
  now: number = Date.now(),
): string {
  if (session.phase === "failed") return "We couldn't start this bot.";
  if (session.consecutiveCheckFailures >= WAKING_RECONNECT_AFTER_FAILURES) {
    return "Reconnecting. Your bot is still waking up.";
  }
  if (now - session.startedAt > WAKING_ESTIMATE_MS) {
    return "This is taking longer than usual. You can close this and come back anytime.";
  }
  const remainingSeconds = Math.max(1, Math.ceil((WAKING_ESTIMATE_MS - (now - session.startedAt)) / 1000));
  const minutes = Math.ceil(remainingSeconds / 60);
  return minutes > 1 ? `About ${minutes} minutes left.` : "About a minute left.";
}
