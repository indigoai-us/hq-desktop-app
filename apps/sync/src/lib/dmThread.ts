// Pure helpers for DM conversation views (DmDetail.svelte and MessagesShell).
//
// The detail window opens scoped to one peer and renders the two-way thread. A
// freshly-arrived inbound DM (broadcast as `dm:new-events`) should fold into the
// open thread live — but only when it belongs to THIS conversation and isn't
// already shown. That decision (peer filter + dedupe) is the part worth testing,
// so it lives here, free of the DOM. The component owns the listen() wiring and
// the field mapping into its rendered message shape.

/** Minimal shape needed to decide whether an inbound DM is already in view. */
export interface ThreadIdLike {
  eventId: string;
}

/** Minimal shape of an inbound DM event for the append decision. */
export interface InboundDmLike {
  eventId: string;
  fromPersonUid: string;
}

/** Shape needed to merge a hydrated snapshot with messages appended in-flight. */
export interface MergeableThreadMessage extends ThreadIdLike {
  createdAt?: string | null;
  direction?: string | null;
  fromPersonUid?: string | null;
  fromEmail?: string | null;
  fromDisplayName?: string | null;
  body?: string | null;
  details?: string | null;
  prompt?: string | null;
}

/**
 * Stable identity for thread reconciliation.
 *
 * Server and realtime messages share an eventId, which is always preferred.
 * The full fallback is deliberately conservative: it is only used for malformed
 * or legacy id-less rows and includes sender, direction, timestamp, and content
 * so two ordinary repeated messages are not collapsed merely because their body
 * text matches.
 */
function threadMessageIdentity(message: MergeableThreadMessage): string {
  const eventId = message.eventId?.trim();
  if (eventId) return `event:${eventId}`;
  return `fallback:${JSON.stringify([
    message.direction ?? null,
    message.fromPersonUid ?? null,
    message.fromEmail ?? null,
    message.fromDisplayName ?? null,
    message.createdAt ?? null,
    message.body ?? null,
    message.details ?? null,
    message.prompt ?? null,
  ])}`;
}

function chronologicalTime(message: MergeableThreadMessage): number {
  const parsed = Date.parse(message.createdAt ?? '');
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Reconcile an authoritative hydrated snapshot with the currently rendered
 * thread. The latter may have gained live or optimistic messages while the
 * request was in flight. Hydrated rows win exact identity collisions, while
 * current-only rows survive and the combined result is rendered oldest-first.
 */
export function mergeHydratedThread<T extends MergeableThreadMessage>(
  hydrated: T[],
  current: T[],
): T[] {
  const merged = new Map<string, { message: T; order: number }>();
  let order = 0;
  for (const message of [...hydrated, ...current]) {
    const identity = threadMessageIdentity(message);
    if (!merged.has(identity)) {
      merged.set(identity, { message, order });
      order += 1;
    }
  }

  return [...merged.values()]
    .sort((left, right) => {
      const leftTime = chronologicalTime(left.message);
      const rightTime = chronologicalTime(right.message);
      if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
      return left.order - right.order;
    })
    .map(({ message }) => message);
}

/**
 * True when a freshly-arrived inbound DM should be appended to the open thread:
 * it must be from the peer the window is scoped to (`peerUid`) and not already
 * present (by `eventId`). Returns false for DMs from another peer (this window
 * is a single conversation), for an unset peer (nothing open yet), and for
 * duplicates (the poll can re-surface an event, and the same id may also land in
 * a later fetch_dm_thread).
 */
export function shouldAppendInbound(
  messages: ThreadIdLike[],
  dm: InboundDmLike,
  peerUid: string | null | undefined,
): boolean {
  if (!peerUid || dm.fromPersonUid !== peerUid) return false;
  return !messages.some((m) => m.eventId === dm.eventId);
}

/**
 * Append a batch of freshly-arrived inbound DMs to an already-rendered thread.
 * The caller supplies the renderer-specific mapping because DmDetail and
 * MessagesShell carry slightly different message shapes, while the peer/dedupe
 * rule stays identical.
 */
export function appendInboundBatch<T extends ThreadIdLike, Dm extends InboundDmLike>(
  messages: T[],
  dms: Dm[],
  peerUid: string | null | undefined,
  toMessage: (dm: Dm) => T,
): T[] {
  let next = messages;
  for (const dm of dms) {
    if (shouldAppendInbound(next, dm, peerUid)) {
      next = [...next, toMessage(dm)];
    }
  }
  return next;
}
