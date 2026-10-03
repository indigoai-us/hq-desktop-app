/**
 * Lifecycle-card action helpers (US-009).
 *
 * The card renderer stays zero-network. The host generates one idempotency
 * key per in-flight (channel, card, action) so a double-submit replays the
 * first result. Failures patch the in-memory envelope to `blocked` so the
 * reason renders on the card — never toast-only.
 */

import type { ConversationApi, ConversationMessageWire } from "./chat-api.js";
import type {
  LifecycleCardActionEvent,
  LifecycleCardState,
} from "./messaging/channelMessageModels.js";

export interface CardActionIdempotencyEntry {
  key: string;
  n: number;
}

export type CardActionIdempotencyStore = Map<
  string,
  CardActionIdempotencyEntry
>;

function actionKey(event: {
  channelId: string;
  cardId: string;
  actionId: string;
}): string {
  return `${event.channelId}:${event.cardId}:${event.actionId}`;
}

export function beginCardActionIdempotencyKey(
  store: CardActionIdempotencyStore,
  event: { channelId: string; cardId: string; actionId: string },
  create: () => string = () => crypto.randomUUID(),
): string {
  const id = actionKey(event);
  const existing = store.get(id);
  if (existing) {
    existing.n += 1;
    return existing.key;
  }
  const key = create();
  store.set(id, { key, n: 1 });
  return key;
}

export function endCardActionIdempotencyKey(
  store: CardActionIdempotencyStore,
  event: { channelId: string; cardId: string; actionId: string },
): void {
  const id = actionKey(event);
  const existing = store.get(id);
  if (!existing) return;
  existing.n -= 1;
  if (existing.n <= 0) store.delete(id);
}

export const CARD_ACTION_FORBIDDEN_MESSAGE =
  "You don't have permission to do this. Ask a workspace owner or admin.";
export const CARD_ACTION_FAILED_MESSAGE = "That didn't work. Try again.";
/** Transient copy keeps the word "connection" so the card stays open for retry. */
export const CARD_ACTION_OFFLINE_MESSAGE = "Couldn't reach HQ. Check your connection and try again.";

/**
 * Plain copy for a failed card/lifecycle action. The raw adapter/server text
 * is logged, never shown.
 */
export function cardActionFailureMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  console.warn("[card-action] action failed", raw);
  if (/\b403\b|forbidden|permission|owners? only|only owners|cannot act|not allowed/i.test(raw)) {
    return CARD_ACTION_FORBIDDEN_MESSAGE;
  }
  if (/timed? out|timeout|network|connection|unavailable|fetch failed|could not reach|\b50[234]\b/i.test(raw)) {
    return CARD_ACTION_OFFLINE_MESSAGE;
  }
  return CARD_ACTION_FAILED_MESSAGE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Patch a lifecycle_card envelope in place (same eventId, new state). */
export function patchLifecycleCardState(
  messages: ConversationMessageWire[],
  cardId: string,
  patch: { state: LifecycleCardState; reason?: string | null; values?: Record<string, string> },
): ConversationMessageWire[] {
  let changed = false;
  const next = messages.map((msg) => {
    if (!isRecord(msg.systemEvent)) return msg;
    if (msg.systemEvent.type !== "lifecycle_card") return msg;
    if (msg.systemEvent.cardId !== cardId) return msg;
    changed = true;
    return {
      ...msg,
      systemEvent: {
        ...msg.systemEvent,
        state: patch.state,
        ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
        ...(patch.values && Array.isArray(msg.systemEvent.fields) ? {
          fields: msg.systemEvent.fields.map((field: unknown) => isRecord(field) && typeof field.id === "string" && patch.values![field.id] !== undefined
            ? { ...field, value: patch.values![field.id] }
            : field),
        } : {}),
        ...(patch.state === "open" && patch.reason ? { statusLabel: "Please retry" } : {}),
        ...(patch.state === "blocked" ? { statusLabel: "Blocked" } : {}),
      },
    };
  });
  return changed ? next : messages;
}

export async function submitLifecycleCardAction(opts: {
  event: LifecycleCardActionEvent;
  store: CardActionIdempotencyStore;
  run: ConversationApi["runCardAction"];
  onFailure: (cardId: string, message: string) => void;
}): Promise<Awaited<ReturnType<ConversationApi["runCardAction"]>> | void> {
  const idempotencyKey = beginCardActionIdempotencyKey(opts.store, opts.event);
  try {
    return await opts.run({
      channelId: opts.event.channelId,
      cardId: opts.event.cardId,
      actionId: opts.event.actionId,
      values: opts.event.values,
      idempotencyKey,
    });
  } catch (err) {
    opts.onFailure(opts.event.cardId, cardActionFailureMessage(err));
  } finally {
    endCardActionIdempotencyKey(opts.store, opts.event);
  }
}
