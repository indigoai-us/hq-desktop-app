/**
 * Pure helpers for thread-reply routing in the Messages conversation list.
 *
 * The server's DM-scope thread GET omits top-level `replyCount`, and per-message
 * `rootEventId` / `replyCount` used to be dropped by the Rust structs. These
 * helpers compute an effective count, keep reply rows out of the main list, and
 * fold that metadata onto the matching root so Conversation's existing
 * `hasReplies()` affordance can render.
 */

export type ThreadReplyRef = {
  eventId?: string | null;
  rootEventId?: string | null;
};

export type FoldableMessage = {
  eventId: string;
  rootEventId?: string | null;
  replyCount?: number | null;
  lastReplyAt?: string | null;
  createdAt?: string | null;
};

export type InboundReply = {
  eventId: string;
  rootEventId?: string | null;
  createdAt?: string | null;
};

/** A row is a reply iff `rootEventId` is set and is not the row's own eventId. */
export function isThreadReply(row: ThreadReplyRef): boolean {
  const root = (row.rootEventId ?? '').trim();
  if (!root) return false;
  const id = (row.eventId ?? '').trim();
  return !id || root !== id;
}

export function effectiveReplyCount(
  viewReplyCount: number | null | undefined,
  rootReplyCount: number | null | undefined,
  repliesLen: number,
): number {
  return Math.max(viewReplyCount ?? 0, rootReplyCount ?? 0, repliesLen);
}

export function partitionThreadReplies<T extends ThreadReplyRef>(
  events: T[],
): { topLevel: T[]; replies: T[] } {
  const topLevel: T[] = [];
  const replies: T[] = [];
  for (const event of events) {
    if (isThreadReply(event)) replies.push(event);
    else topLevel.push(event);
  }
  return { topLevel, replies };
}

function laterTimestamp(
  candidate: string | null | undefined,
  current: string | null | undefined,
): string | null {
  const next = (candidate ?? '').trim();
  if (!next) return current ?? null;
  const currentValue = (current ?? '').trim();
  if (!currentValue) return next;
  const nextTs = Date.parse(next);
  const currentTs = Date.parse(currentValue);
  if (!Number.isFinite(nextTs)) return currentValue;
  if (!Number.isFinite(currentTs) || nextTs >= currentTs) return next;
  return currentValue;
}

/**
 * Drop reply rows from a main-list snapshot and copy count + lastReplyAt onto
 * their root. A larger server `replyCount` wins over the number of loaded
 * replies (the list page may not include every reply).
 */
export function foldReplies<T extends FoldableMessage>(messages: T[]): T[] {
  const { topLevel, replies } = partitionThreadReplies(messages);
  const repliesByRoot = new Map<string, T[]>();
  for (const reply of replies) {
    const rootId = (reply.rootEventId ?? '').trim();
    if (!rootId) continue;
    const list = repliesByRoot.get(rootId) ?? [];
    list.push(reply);
    repliesByRoot.set(rootId, list);
  }

  return topLevel.map((root) => {
    const threadReplies = repliesByRoot.get(root.eventId) ?? [];
    const replyCount = Math.max(root.replyCount ?? 0, threadReplies.length);
    if (replyCount <= 0) return root;

    let lastReplyAt = root.lastReplyAt ?? null;
    for (const reply of threadReplies) {
      lastReplyAt = laterTimestamp(reply.createdAt, lastReplyAt);
    }

    return {
      ...root,
      rootEventId: (root.rootEventId ?? '').trim() || root.eventId,
      replyCount,
      lastReplyAt,
    };
  });
}

/**
 * Apply live inbound replies onto matching roots. Increments `replyCount` by 1
 * per unseen `eventId` (the same reply is not double-counted). Sets
 * `rootEventId` on the root if missing and records `lastReplyAt`.
 */
export function applyInboundReplies<T extends FoldableMessage>(
  messages: T[],
  replies: InboundReply[],
  countedReplyIds: Set<string>,
): T[] {
  let next = messages;
  for (const reply of replies) {
    const rootId = (reply.rootEventId ?? '').trim();
    const replyId = reply.eventId.trim();
    if (!rootId || !replyId || countedReplyIds.has(replyId)) continue;

    let bumped = false;
    const mapped = next.map((message) => {
      if (message.eventId !== rootId) return message;
      bumped = true;
      return {
        ...message,
        rootEventId: message.rootEventId ?? message.eventId,
        replyCount: (message.replyCount ?? 0) + 1,
        lastReplyAt: reply.createdAt ?? message.lastReplyAt ?? null,
      };
    });
    if (!bumped) continue;
    countedReplyIds.add(replyId);
    next = mapped;
  }
  return next;
}
