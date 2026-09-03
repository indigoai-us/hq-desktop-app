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

/** Strip adapter `[code] ` prefixes so the card shows the permission reason. */
export function cardActionFailureMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const stripped = raw.replace(/^\[[^\]]+]\s*/, "").trim();
  return stripped || "This action isn't allowed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Patch a lifecycle_card envelope in place (same eventId, new state). */
export function patchLifecycleCardState(
  messages: ConversationMessageWire[],
  cardId: string,
  patch: { state: LifecycleCardState; reason?: string | null },
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
