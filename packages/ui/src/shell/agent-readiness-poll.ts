/**
 * When to ask a cloud bot's setup status again while its channel is open and
 * the composer waits for it.
 *
 * The read used to repeat every 5 s for as long as the channel stayed open,
 * whatever came back: a bot whose setup had failed, a bot that was removed,
 * a person the server will not show the status to. None of those change by
 * asking again five seconds later.
 *
 * It stops for good only for what cannot change: a bot that is ready, a bot
 * that is being removed, a read the server refuses for this person. A setup
 * that failed, and a sign-in the server did not accept, can both mend
 * without the person reopening the channel, so those are read again once a
 * minute. Nothing else re-arms the read, and the composer stays locked until
 * a read says the bot can chat.
 */

import type { AgentChatReadiness } from "../chat/agent-channel.js";

/** Until the bot can chat. */
export const AGENT_CHAT_READY_POLL_MS = 5_000;
/** While it can chat and its files are still arriving. */
export const AGENT_CATCHING_UP_POLL_MS = 30_000;
/**
 * While the setup stands failed, or the app's own sign-in was refused. Both
 * can change without the person doing anything here (a retry of the setup, a
 * token refresh), so the read goes on, slowly.
 */
export const AGENT_READINESS_SLOW_POLL_MS = 60_000;
/** The longest wait between reads that keep failing. */
export const AGENT_READINESS_MAX_BACKOFF_MS = 60_000;

/** What one read of the status came back with. */
export type ReadinessRead =
  /** The server answered. */
  | { kind: "status"; readiness: AgentChatReadiness }
  /** The server will not show this person the bot, or does not know it (403, 404). */
  | { kind: "denied" }
  /** The server did not accept the app's sign-in (401). A token refresh mends that. */
  | { kind: "signed-out" }
  /** Anything else: the network, a timeout, a server error. */
  | { kind: "failed" };

function failureStatus(result: unknown): number | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const rec = result as Record<string, unknown>;
  if (rec.ok !== false) return null;
  if (typeof rec.status === "number") return rec.status;
  const code = typeof rec.code === "string" ? rec.code.trim().toLowerCase() : "";
  const match = /^http-(\d{3})$/.exec(code);
  return match ? Number(match[1]) : null;
}

/**
 * A failed read that asking again will not change: the server says this
 * person may not read the bot's status (403), or that there is no such bot
 * (404). A 401 is not one of these: it is about the app's sign-in, which a
 * token refresh renews.
 */
export function readinessReadDenied(result: unknown): boolean {
  const status = failureStatus(result);
  return status === 403 || status === 404;
}

/** A failed read because the app's sign-in was not accepted (401). */
export function readinessReadSignedOut(result: unknown): boolean {
  return failureStatus(result) === 401;
}

/** What a read that did not succeed came back with. */
export function readinessFailureRead(result: unknown): ReadinessRead {
  if (readinessReadDenied(result)) return { kind: "denied" };
  if (readinessReadSignedOut(result)) return { kind: "signed-out" };
  return { kind: "failed" };
}

/**
 * How long to wait before the next read (ms), or null to stop asking.
 *
 * - The bot is fully ready: stop. Nothing is waited for.
 * - The bot is being removed, or is gone: stop. Its setup will not move on,
 *   and the server answers this way until the bot is deleted.
 * - The read was refused for this person, or the bot is unknown (403, 404):
 *   stop.
 * - The setup failed: once a minute. A setup that is retried starts moving
 *   again, and the composer must unlock when it does.
 * - The app's sign-in was refused (401): once a minute. One such answer
 *   during a token refresh must not lock the composer for good.
 * - The bot can chat and its files are still arriving: the slow timer.
 * - The bot cannot chat yet: every 5 s.
 * - The read failed for another reason: wait longer each time it fails in a
 *   row (10 s, 20 s, 40 s, then a minute), and go back to the usual timer as
 *   soon as one succeeds.
 *
 * `consecutiveFailures` counts this read when it failed.
 */
export function nextReadinessPollMs(read: ReadinessRead, consecutiveFailures: number): number | null {
  if (read.kind === "denied") return null;
  if (read.kind === "signed-out") return AGENT_READINESS_SLOW_POLL_MS;
  if (read.kind === "failed") {
    const failures = Math.max(1, Math.floor(Number.isFinite(consecutiveFailures) ? consecutiveFailures : 1));
    return Math.min(AGENT_CHAT_READY_POLL_MS * 2 ** Math.min(failures, 20), AGENT_READINESS_MAX_BACKOFF_MS);
  }
  const { readiness } = read;
  if (readiness.removing) return null;
  if (readiness.failed) return AGENT_READINESS_SLOW_POLL_MS;
  if (readiness.chatReady && !readiness.catchingUp) return null;
  return readiness.chatReady ? AGENT_CATCHING_UP_POLL_MS : AGENT_CHAT_READY_POLL_MS;
}

type OnlineTarget = Pick<Window, "addEventListener" | "removeEventListener">;

export interface ReadinessPollOptions {
  /**
   * Where the `online` event is heard. The window by default; null for none.
   * When the connection comes back, a wait that grew while reads were
   * failing is cut short and the status is read at once.
   */
  onlineTarget?: OnlineTarget | null;
}

/**
 * Read a bot's status now, and again for as long as `nextReadinessPollMs`
 * says to. One timer at a time, chained, never an interval. `readOnce` says
 * what the read came back with; one that throws counts as a failed read.
 * Returns the way to stop.
 */
export function startReadinessPoll(
  readOnce: () => Promise<ReadinessRead>,
  options: ReadinessPollOptions = {},
): () => void {
  const onlineTarget =
    options.onlineTarget === undefined ? (typeof window === "undefined" ? null : window) : options.onlineTarget;
  let stopped = false;
  let reading = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

  function stop(): void {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    onlineTarget?.removeEventListener("online", onOnline);
  }

  async function check(): Promise<void> {
    reading = true;
    let read: ReadinessRead = { kind: "failed" };
    try {
      read = await readOnce();
    } catch (error) {
      console.warn("[hq-ui] agent readiness read failed:", error);
      // A failed read: ask again, less often each time.
    }
    reading = false;
    if (stopped) return;
    failures = read.kind === "failed" ? failures + 1 : 0;
    const wait = nextReadinessPollMs(read, failures);
    if (wait === null) {
      stop();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, wait);
  }

  /** The connection is back: do not sit out a long wait, read now. */
  function onOnline(): void {
    if (stopped || reading || !timer) return;
    clearTimeout(timer);
    timer = null;
    failures = 0;
    void check();
  }

  onlineTarget?.addEventListener("online", onOnline);
  void check();
  return stop;
}
