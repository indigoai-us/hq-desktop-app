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
