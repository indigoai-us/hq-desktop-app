/**
 * Optimistic channel-send state machine (US-004).
 *
 * Plain TypeScript — no Svelte — so the pending → sending → delivered | failed
 * flow is unit-testable. The timeline/composer consume the resulting
 * `OutboundMessage` objects; ack = successful `send_channel_message` invoke.
 *
 * Contract:
 * - Message object is NEVER dropped on failure (body retained for retry).
 * - Bounded retries with exponential backoff (default 3 attempts).
 * - `retry()` from `failed` re-enters `sending`.
 */

export type SendStatus = 'pending' | 'sending' | 'delivered' | 'failed';

export interface OutboundMessage {
  /** Stable client id used as the optimistic timeline eventId until ack. */
  clientId: string;
  body: string;
  status: SendStatus;
  /** Number of send attempts already started (including in-flight). */
  attempts: number;
  createdAt: string;
  /** Last error message when status is `failed`. */
  error?: string;
}

export interface SendMachineOptions {
  /** Max send attempts before status becomes `failed`. Default 3. */
  maxAttempts?: number;
  /**
   * Backoff delay (ms) before attempt N (1-indexed after the first failure).
   * Default: 250 * 2^(attempt-1) → 250, 500, 1000…
   */
  backoffMs?: (attempt: number) => number;
  /** Perform one network send. Resolve on ack; reject on failure. */
  send: (body: string) => Promise<void>;
  /** Optional sleep (injectable for tests). Default `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after every status transition with a shallow clone. */
  onChange?: (msg: OutboundMessage) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export function defaultBackoffMs(attempt: number): number {
  // attempt is the NEXT attempt number (2 for first retry, …).
  const n = Math.max(1, attempt - 1);
  return 250 * 2 ** (n - 1);
}

let clientSeq = 0;

/** Create a new outbound message in `pending` (not yet in flight). */
export function createOutboundMessage(body: string, now = () => new Date().toISOString()): OutboundMessage {
  clientSeq += 1;
  return {
    clientId: `local-send-${Date.now()}-${clientSeq}`,
    body,
    status: 'pending',
    attempts: 0,
    createdAt: now(),
  };
}

function emit(msg: OutboundMessage, onChange?: (m: OutboundMessage) => void): OutboundMessage {
  // Notify with a shallow snapshot so listeners can't mutate our in-progress
  // object mid-flight, but always return the original so list identity is stable.
  onChange?.({ ...msg });
  return msg;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drive `msg` through sending with bounded retries until delivered or failed.
 * Mutates and returns the same object so callers can keep a stable reference
 * in a message list.
 */
export async function runSend(
  msg: OutboundMessage,
  options: SendMachineOptions,
): Promise<OutboundMessage> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  const sleep = options.sleep ?? defaultSleep;
  const { send, onChange } = options;

  // Re-entry from `failed` or first kick from `pending`.
  if (msg.status === 'delivered') return msg;

  while (msg.attempts < maxAttempts) {
    msg.status = 'sending';
    msg.attempts += 1;
    msg.error = undefined;
    emit(msg, onChange);

    try {
      await send(msg.body);
      msg.status = 'delivered';
      msg.error = undefined;
      return emit(msg, onChange);
    } catch (err) {
      const message = typeof err === 'string' ? err : err instanceof Error ? err.message : 'Failed to send message';
      msg.error = message;
      if (msg.attempts >= maxAttempts) {
        msg.status = 'failed';
        return emit(msg, onChange);
      }
      // Stay in sending visually during backoff so the user sees progress, then
      // loop for the next attempt. Status stays `sending` until final failure.
      const wait = backoffMs(msg.attempts + 1);
      if (wait > 0) await sleep(wait);
    }
  }

  msg.status = 'failed';
  if (!msg.error) msg.error = 'Failed to send message';
  return emit(msg, onChange);
}

/**
 * Retry a failed outbound message. Re-enters `sending` and resets only the
 * status — body and clientId are retained (never dropped). Attempt counter
 * continues from the previous value unless `resetAttempts` is true.
 */
export async function retrySend(
  msg: OutboundMessage,
  options: SendMachineOptions & { resetAttempts?: boolean },
): Promise<OutboundMessage> {
  if (msg.status === 'delivered' || msg.status === 'sending') return msg;
  if (options.resetAttempts) msg.attempts = 0;
  // Cap remaining attempts: retry from failed always gets a full new budget
  // so the user can keep trying after exhaustion (tap-to-retry UX).
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  msg.attempts = 0;
  return runSend(msg, { ...options, maxAttempts });
}

/** Status label for the timeline footer. */
export function sendStatusLabel(status: SendStatus): string {
  switch (status) {
    case 'pending':
    case 'sending':
      return 'Sending…';
    case 'delivered':
      return 'Delivered';
    case 'failed':
      return 'Failed — tap to retry';
  }
}
