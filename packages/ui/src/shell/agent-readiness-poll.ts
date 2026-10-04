/**
 * When to ask a cloud bot's setup status again while its channel is open and
 * the composer waits for it.
 *
 * The read used to repeat every 5 s for as long as the channel stayed open,
 * whatever came back: a bot whose setup had failed, a bot that was removed,
 * a person the server will not show the status to. None of those change by
 * asking again five seconds later.
 */

import type { AgentChatReadiness } from "../chat/agent-channel.js";

/** Until the bot can chat. */
export const AGENT_CHAT_READY_POLL_MS = 5_000;
/** While it can chat and its files are still arriving. */
export const AGENT_CATCHING_UP_POLL_MS = 30_000;
/** The longest wait between reads that keep failing. */
export const AGENT_READINESS_MAX_BACKOFF_MS = 300_000;

/** What one read of the status came back with. */
export type ReadinessRead =
  /** The server answered. */
  | { kind: "status"; readiness: AgentChatReadiness }
  /** The server refused this person, or does not know the bot (401, 403, 404). */
  | { kind: "denied" }
  /** Anything else: the network, a timeout, a server error. */
  | { kind: "failed" };

/**
 * A failed read that asking again will not change: the server says this
 * person may not read the bot's status, or that there is no such bot.
 */
export function readinessReadDenied(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const rec = result as Record<string, unknown>;
  if (rec.ok !== false) return false;
  const status = typeof rec.status === "number" ? rec.status : null;
  const code = typeof rec.code === "string" ? rec.code.trim().toLowerCase() : "";
  return status === 401 || status === 403 || status === 404 || code === "http-401" || code === "http-403" || code === "http-404";
}

/**
 * How long to wait before the next read (ms), or null to stop asking.
 *
 * - The setup failed, or the bot is fully ready: stop. Neither changes by itself.
 * - The bot is being removed, or is gone: stop. Its setup will not move on,
 *   and the server answers this way until the bot is deleted.
 * - The read was refused: stop.
 * - The bot can chat and its files are still arriving: the slow timer.
 * - The bot cannot chat yet: every 5 s.
 * - The read failed for another reason: wait longer each time it fails in a
 *   row (10 s, 20 s, 40 s, ... up to five minutes), and go back to the usual
 *   timer as soon as one succeeds.
 *
 * `consecutiveFailures` counts this read when it failed.
 */
export function nextReadinessPollMs(read: ReadinessRead, consecutiveFailures: number): number | null {
  if (read.kind === "denied") return null;
  if (read.kind === "failed") {
    const failures = Math.max(1, Math.floor(Number.isFinite(consecutiveFailures) ? consecutiveFailures : 1));
    return Math.min(AGENT_CHAT_READY_POLL_MS * 2 ** Math.min(failures, 20), AGENT_READINESS_MAX_BACKOFF_MS);
  }
  const { readiness } = read;
  if (readiness.failed || readiness.removing) return null;
  if (readiness.chatReady && !readiness.catchingUp) return null;
  return readiness.chatReady ? AGENT_CATCHING_UP_POLL_MS : AGENT_CHAT_READY_POLL_MS;
}
