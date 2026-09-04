/**
 * Cursor catch-up policy: MQTT is liveness; REST + cursors are completeness.
 * Arm the directory safety poll only when the socket is not healthy.
 */

export type MeshConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "paused-hidden"
  | "closed";

export function shouldArmDirectorySafety(
  state: MeshConnectionState | string | undefined,
): boolean {
  return state !== "connected";
}

/** Open-timeline REST poll while MQTT is not connected. */
export const TIMELINE_SAFETY_INTERVAL_MS = 8_000;

export const DM_INBOX_SINCE_KEY = "hq.chat.dm-inbox-since";

/** True when a type:dm wake should increment the rail badge. */
export function shouldBumpDmUnread(args: {
  selectedId?: string | null;
  fromPersonUid?: string | null;
  selfUid?: string | null;
}): boolean {
  const fromPersonUid = (args.fromPersonUid ?? "").trim();
  if (!fromPersonUid) return false;
  const selfUid = (args.selfUid ?? "").trim();
  if (selfUid && fromPersonUid === selfUid) return false;
  const selected = (args.selectedId ?? "").trim();
  if (!selected) return true;
  return selected !== `dm:${fromPersonUid}`;
}

export interface InboxPairUnread {
  withPersonUid: string;
  unreadCount: number;
}

/** Newest inbound DM per counterpart, derived from an inbox page's events. */
export interface InboxDmActivity {
  personUid: string;
  lastMessageAt: string;
  displayName?: string;
}

/**
 * Per-pair last-message stamps from GET /v1/notify/inbox `events`.
 * `pairUnreadsFromInboxPage` only derives unread counts; this keeps the
 * timestamps the rail needs to show older-day DM rows.
 */
export function dmActivityFromInboxPage(
  page: unknown,
  opts?: { selfUid?: string },
): InboxDmActivity[] {
  const rec =
    page && typeof page === "object" && !Array.isArray(page)
      ? (page as Record<string, unknown>)
      : null;
  if (!rec) return [];
  const events = Array.isArray(rec.events) ? rec.events : [];
  const selfUid = opts?.selfUid?.trim() ?? "";
  const latest = new Map<string, InboxDmActivity>();
  for (const item of events) {
    if (!item || typeof item !== "object") continue;
    const uid =
      typeof (item as { fromPersonUid?: unknown }).fromPersonUid === "string"
        ? (item as { fromPersonUid: string }).fromPersonUid.trim()
        : "";
    if (!uid || uid === selfUid) continue;
    const createdAt = (item as { createdAt?: unknown }).createdAt;
    if (typeof createdAt !== "string" || !createdAt) continue;
    const prev = latest.get(uid);
    if (prev && createdAt <= prev.lastMessageAt) continue;
    const displayName = (item as { fromDisplayName?: unknown }).fromDisplayName;
    latest.set(uid, {
      personUid: uid,
      lastMessageAt: createdAt,
      ...(typeof displayName === "string" && displayName
        ? { displayName }
        : {}),
    });
  }
  return [...latest.values()];
}

/**
 * Newest `createdAt` across a DM timeline, regardless of direction, sender,
 * messageKind, or empty body (delegation/handoff cards still count).
 */
export function dmActivityFromTimeline<T extends { createdAt?: unknown }>(
  personUid: string,
  messages: ReadonlyArray<T | null | undefined>,
): InboxDmActivity | null {
  const uid = personUid.trim();
  if (!uid) return null;
  let lastMessageAt: string | null = null;
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const createdAt = (item as { createdAt?: unknown }).createdAt;
    if (typeof createdAt !== "string" || !createdAt) continue;
    if (!lastMessageAt || createdAt > lastMessageAt) lastMessageAt = createdAt;
  }
  if (!lastMessageAt) return null;
  return { personUid: uid, lastMessageAt };
}

/** Newest timeline stamp for a channel / group row — any direction counts. */
export interface ChannelRailActivity {
  channelId: string;
  lastMessageAt: string;
  fromPersonUid?: string;
  eventId?: string;
}

/**
 * Newest `createdAt` across a channel timeline, regardless of direction,
 * sender, or empty body. Own sends and loaded history both count so the rail
 * can regroup the channel under the day of that stamp.
 */
export function channelActivityFromTimeline<
  T extends {
    createdAt?: unknown;
    fromPersonUid?: unknown;
    eventId?: unknown;
  },
>(
  channelId: string,
  messages: ReadonlyArray<T | null | undefined>,
): ChannelRailActivity | null {
  const id = channelId.trim();
  if (!id) return null;
  let lastMessageAt: string | null = null;
  let fromPersonUid: string | undefined;
  let eventId: string | undefined;
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const createdAt = (item as { createdAt?: unknown }).createdAt;
    if (typeof createdAt !== "string" || !createdAt) continue;
    if (lastMessageAt && createdAt <= lastMessageAt) continue;
    lastMessageAt = createdAt;
    const from = (item as { fromPersonUid?: unknown }).fromPersonUid;
    fromPersonUid =
      typeof from === "string" && from.trim() ? from.trim() : undefined;
    const event = (item as { eventId?: unknown }).eventId;
    eventId =
      typeof event === "string" && event.trim() ? event.trim() : undefined;
  }
  if (!lastMessageAt) return null;
  return {
    channelId: id,
    lastMessageAt,
    ...(fromPersonUid ? { fromPersonUid } : {}),
    ...(eventId ? { eventId } : {}),
  };
}

/**
 * GET /v1/notify/dm-threads page → rail activity, one entry per peer. Unlike
 * the inbox this index is written for BOTH directions of every DM, so a pair
 * where the owner sent last (and one whose history fell out of the capped
 * inbox window) still yields a stamp. Rows carry no names or content.
 */
export function dmActivityFromThreadsPage(
  page: unknown,
  opts?: { selfUid?: string },
): InboxDmActivity[] {
  const rec =
    page && typeof page === "object" && !Array.isArray(page)
      ? (page as Record<string, unknown>)
      : null;
  if (!rec) return [];
  const threads = Array.isArray(rec.threads) ? rec.threads : [];
  const selfUid = opts?.selfUid?.trim() ?? "";
  const latest = new Map<string, InboxDmActivity>();
  for (const item of threads) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const uid = typeof row.peerUid === "string" ? row.peerUid.trim() : "";
    if (!uid || uid === selfUid) continue;
    const at = row.lastActivityAt;
    if (typeof at !== "string" || !at) continue;
    const prev = latest.get(uid);
    if (prev && at <= prev.lastMessageAt) continue;
    latest.set(uid, { personUid: uid, lastMessageAt: at });
  }
  return [...latest.values()];
}

/** Newest stamp per peer across several activity lists (names kept when known). */
export function mergeDmActivity(
  ...lists: ReadonlyArray<readonly InboxDmActivity[]>
): InboxDmActivity[] {
  const byUid = new Map<string, InboxDmActivity>();
  for (const list of lists) {
    for (const entry of list) {
      const uid = entry.personUid.trim();
      if (!uid || !entry.lastMessageAt) continue;
      const prev = byUid.get(uid);
      if (!prev) {
        byUid.set(uid, { ...entry, personUid: uid });
        continue;
      }
      const newer = entry.lastMessageAt > prev.lastMessageAt ? entry : prev;
      byUid.set(uid, {
        personUid: uid,
        lastMessageAt: newer.lastMessageAt,
        ...(prev.displayName || entry.displayName
          ? { displayName: prev.displayName || entry.displayName }
          : {}),
      });
    }
  }
  return [...byUid.values()];
}

/**
 * True when a failed adapter call means "this host/server has no such
 * endpoint" (HTTP 404, a NOT_FOUND-style code, or an adapter that reports the
 * API as unavailable) — i.e. fall back rather than retry.
 */
export function isMissingEndpointFailure(
  failure: { ok: false; reason?: string; code?: string } | null | undefined,
): boolean {
  if (!failure) return false;
  if (failure.reason === "unavailable") return true;
  const code = (failure.code ?? "").trim().toUpperCase();
  return code === "HTTP-404" || code.includes("NOT_FOUND") || code.includes("NOT-FOUND");
}

/** Turn an inbox page into a one-row unread patch + the next exclusive since. */
export function pairUnreadsFromInboxPage(
  page: unknown,
  opts: { since?: string; selfUid?: string } = {},
): { pairUnreads?: InboxPairUnread[]; nextSince?: string; delta?: boolean } {
  const rec =
    page && typeof page === "object" && !Array.isArray(page)
      ? (page as Record<string, unknown>)
      : null;
  const events = Array.isArray(rec?.events) ? rec.events : [];
  let nextSince = opts.since;
  for (const item of events) {
    if (!item || typeof item !== "object") continue;
    const createdAt = (item as { createdAt?: unknown }).createdAt;
    if (
      typeof createdAt === "string" &&
      createdAt &&
      (!nextSince || createdAt > nextSince)
    ) {
      nextSince = createdAt;
    }
  }
  const listed = rec?.pairUnreads;
  if (Array.isArray(listed) && listed.length > 0) {
    const pairUnreads: InboxPairUnread[] = [];
    for (const row of listed) {
      if (!row || typeof row !== "object") continue;
      const withPersonUid =
        typeof (row as { withPersonUid?: unknown }).withPersonUid === "string"
          ? (row as { withPersonUid: string }).withPersonUid.trim()
          : "";
      const unreadCount = (row as { unreadCount?: unknown }).unreadCount;
      if (!withPersonUid || typeof unreadCount !== "number") continue;
      pairUnreads.push({ withPersonUid, unreadCount });
    }
    return {
      ...(pairUnreads.length > 0 ? { pairUnreads } : {}),
      ...(nextSince ? { nextSince } : {}),
    };
  }
  // No server rollup: increment from events only after we have a since cursor.
  if (!opts.since) {
    return nextSince ? { nextSince } : {};
  }
  const counts = new Map<string, number>();
  const selfUid = opts.selfUid?.trim() ?? "";
  for (const item of events) {
    if (!item || typeof item !== "object") continue;
    const uid =
      typeof (item as { fromPersonUid?: unknown }).fromPersonUid === "string"
        ? (item as { fromPersonUid: string }).fromPersonUid.trim()
        : "";
    if (!uid || uid === selfUid) continue;
    counts.set(uid, (counts.get(uid) ?? 0) + 1);
  }
  return {
    ...(counts.size > 0
      ? {
          pairUnreads: [...counts.entries()].map(
            ([withPersonUid, unreadCount]) => ({
              withPersonUid,
              unreadCount,
            }),
          ),
          delta: true,
        }
      : {}),
    ...(nextSince ? { nextSince } : {}),
  };
}
