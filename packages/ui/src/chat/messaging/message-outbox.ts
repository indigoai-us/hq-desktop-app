/**
 * In-memory send queue for Messages while the app is offline.
 * Flush sends the oldest item first and stops on the first failure so order holds.
 */

export interface OutboxItem<T> {
  id: string;
  payload: T;
}

export interface MessageOutbox<T> {
  readonly size: number;
  list(): OutboxItem<T>[];
  enqueue(payload: T): string;
  flush(send: (payload: T) => Promise<void>): Promise<void>;
}

export function createMessageOutbox<T>(): MessageOutbox<T> {
  const items: OutboxItem<T>[] = [];
  let seq = 0;
  let flushing = false;
  return {
    get size() {
      return items.length;
    },
    list() {
      return items.slice();
    },
    enqueue(payload) {
      const id = `q${++seq}`;
      items.push({ id, payload });
      return id;
    },
    async flush(send) {
      if (flushing) return;
      flushing = true;
      try {
        while (items.length > 0) {
          await send(items[0].payload);
          items.shift();
        }
      } finally {
        flushing = false;
      }
    },
  };
}

/** Return value from a host send that parked the body instead of posting it. */
export const QUEUED_SEND_PREFIX = "queued:";

export function queuedSendToken(id: string): string {
  return `${QUEUED_SEND_PREFIX}${id}`;
}

export function isQueuedSendToken(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(QUEUED_SEND_PREFIX);
}
