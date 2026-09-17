/**
 * Live DM + share notifications — compose the hq-pro NOTIF store with the
 * v1 inboxes that already exist (GET /v1/notify/inbox, GET
 * /v1/files/shared-with-me). Mention / run / review stay out until those
 * emit paths exist.
 *
 * Store rows win on dedup (they carry server read state). Inbox / share
 * events fill gaps for history that pre-dates emitNotification.
 */

import type { AdapterResult, PlatformAdapter } from "@hq/platform";
import type { NotificationsApi } from "../chat/chat-api";

/** Kinds this slice actually has a backend for. */
export const LIVE_NOTIFICATION_TYPES = ["dm", "file_share", "new_file"] as const;

export type LiveNotificationType = (typeof LIVE_NOTIFICATION_TYPES)[number];

export const DM_ID_PREFIX = "dm:";
export const SHARE_ID_PREFIX = "share:";
export const FILE_ID_PREFIX = "file:";
export const LOCAL_ID_PREFIX = "local:";

export type NotificationAckTarget =
  | { kind: "store"; id: string }
  | { kind: "inbox"; eventId: string }
  | { kind: "share"; eventId: string }
  /**
   * New-file rows have no server ack. They arrive already-read (they never
   * light the bell), so acknowledging one is a no-op rather than a call.
   */
  | { kind: "file"; eventId: string }
  | { kind: "local"; id: string };

export interface LiveNotificationsOptions {
  /** Session-local wake rows which have no NOTIF-store counterpart yet. */
  localNotifications?: () => Record<string, unknown>[];
  ackLocalNotification?: (id: string) => void;
  readAllLocalNotifications?: () => void;
}

export interface InboxEventWire {
  eventId?: unknown;
  fromPersonUid?: unknown;
  fromEmail?: unknown;
  fromDisplayName?: unknown;
  body?: unknown;
  createdAt?: unknown;
  acknowledgedAt?: unknown;
}

export interface ShareEventWire {
  eventId?: unknown;
  issuerEmail?: unknown;
  issuerDisplayName?: unknown;
  issuerPersonUid?: unknown;
  paths?: unknown;
  note?: unknown;
  createdAt?: unknown;
  acknowledgedAt?: unknown;
}

/** One row of GET /v1/notify/file-history — see FileHistoryItem (Rust). */
export interface FileHistoryWire {
  eventId?: unknown;
  path?: unknown;
  bytes?: unknown;
  addedBy?: unknown;
  companyUid?: unknown;
  companySlug?: unknown;
  createdAt?: unknown;
}

export interface ComposedNotificationsFeed {
  notifications: Record<string, unknown>[];
  unreadCount: number;
  nextCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function isLiveNotificationType(
  type: string | null | undefined,
): type is LiveNotificationType {
  return liveSourceKind(type) !== null;
}

function liveSourceKind(
  type: string | null | undefined,
): LiveNotificationType | null {
  const t = (type ?? "").trim().toLowerCase();
  if (t === "dm" || t === "dm_received") return "dm";
  if (t === "file_share" || t === "file_shared") return "file_share";
  if (t === "new_file" || t === "file_added") return "new_file";
  return null;
}

export function classifyNotificationAck(id: string): NotificationAckTarget {
  const trimmed = id.trim();
  if (trimmed.startsWith(DM_ID_PREFIX)) {
    return { kind: "inbox", eventId: trimmed.slice(DM_ID_PREFIX.length) };
  }
  if (trimmed.startsWith(SHARE_ID_PREFIX)) {
    return { kind: "share", eventId: trimmed.slice(SHARE_ID_PREFIX.length) };
  }
  if (trimmed.startsWith(FILE_ID_PREFIX)) {
    return { kind: "file", eventId: trimmed.slice(FILE_ID_PREFIX.length) };
  }
  if (trimmed.startsWith(LOCAL_ID_PREFIX)) return { kind: "local", id: trimmed };
  return { kind: "store", id: trimmed };
}

export function mapInboxEventToNotification(
  raw: InboxEventWire,
): Record<string, unknown> | null {
  const eventId = asString(raw.eventId);
  if (!eventId) return null;
  const actorName =
    asString(raw.fromDisplayName) || asString(raw.fromEmail) || "Someone";
  const body = asString(raw.body);
  const fromUid = asString(raw.fromPersonUid);
  return {
    id: `${DM_ID_PREFIX}${eventId}`,
    type: "dm",
    status: asString(raw.acknowledgedAt) ? "read" : "unread",
    createdAt: asString(raw.createdAt),
    actorName,
    actorPersonUid: fromUid || undefined,
    title: "Sent you a message",
    body,
    context: body,
    targetRef: fromUid ? `/messages/${fromUid}` : "/messages",
    sourceEventId: eventId,
  };
}

export function mapShareEventToNotification(
  raw: ShareEventWire,
): Record<string, unknown> | null {
  const eventId = asString(raw.eventId);
  if (!eventId) return null;
  const actorName =
    asString(raw.issuerDisplayName) || asString(raw.issuerEmail) || "Someone";
  const paths = asStringList(raw.paths);
  const note = asString(raw.note);
  const fileLabel =
    paths.length === 1
      ? paths[0]
      : paths.length > 1
        ? `${paths.length} files`
        : "a file";
  const context = [fileLabel, note].filter(Boolean).join(" · ");
  const issuerUid = asString(raw.issuerPersonUid);
  return {
    id: `${SHARE_ID_PREFIX}${eventId}`,
    type: "file_share",
    status: asString(raw.acknowledgedAt) ? "read" : "unread",
    createdAt: asString(raw.createdAt),
    actorName,
    actorPersonUid: issuerUid || undefined,
    title: "Shared a file",
    body: context,
    context,
    targetRef: "/files",
    sourceEventId: eventId,
  };
}

/**
 * Map one new-file event into a feed row.
 *
 * Deliberately always `status: "read"`. These rows have no server ack
 * (§ NOTIF store has no new_file type), so the only unread state available
 * would be a client-side watermark — a second, divergent read model competing
 * with the server's. Keeping them read makes new-file activity *findable*
 * without ever lighting the bell, and leaves the server authoritative for
 * everything that actually alerts. If the store later emits new_file rows,
 * those win on dedup and the events become first-class unread for free.
 */
export function mapFileHistoryToNotification(
  raw: FileHistoryWire,
): Record<string, unknown> | null {
  const eventId = asString(raw.eventId);
  if (!eventId) return null;
  const path = asString(raw.path);
  if (!path) return null;
  const actorName = asString(raw.addedBy) || "Someone";
  const company = asString(raw.companySlug);
  const context = company ? `${company} · ${path}` : path;
  return {
    id: `${FILE_ID_PREFIX}${eventId}`,
    type: "new_file",
    status: "read",
    createdAt: asString(raw.createdAt),
    actorName,
    title: "Added a file",
    body: context,
    context,
    targetRef: "/files",
    sourceEventId: eventId,
  };
}

function storeFeed(raw: unknown): {
  rows: Record<string, unknown>[];
  unreadCount: number | null;
  nextCursor: string | null;
} {
  if (!isRecord(raw)) return { rows: [], unreadCount: null, nextCursor: null };
  const rows = Array.isArray(raw.notifications)
    ? raw.notifications.filter(isRecord)
    : [];
  const rawUnread = raw.unreadCount ?? raw.unread_count;
  const unread =
    typeof rawUnread === "number"
      ? rawUnread
      : typeof rawUnread === "string" && rawUnread.trim()
        ? Number(rawUnread)
        : NaN;
  const rawCursor = raw.nextCursor ?? raw.next_cursor;
  return {
    rows,
    unreadCount: Number.isFinite(unread) ? Math.max(0, Math.floor(unread)) : null,
    nextCursor: typeof rawCursor === "string" && rawCursor.trim() ? rawCursor : null,
  };
}

function eventList(raw: unknown): Record<string, unknown>[] {
  if (!isRecord(raw) || !Array.isArray(raw.events)) return [];
  return raw.events.filter(isRecord);
}

/**
 * File history answers `{ files: [...] }`, not the `{ events: [...] }` envelope
 * the DM and share inboxes use. Accept `events` too, so a host that normalises
 * the three sources into one shape still composes.
 */
function fileList(raw: unknown): Record<string, unknown>[] {
  if (!isRecord(raw)) return [];
  const rows = Array.isArray(raw.files)
    ? raw.files
    : Array.isArray(raw.events)
      ? raw.events
      : [];
  return rows.filter(isRecord);
}

function isUnreadRow(row: Record<string, unknown>): boolean {
  return asString(row.status).toLowerCase() !== "read";
}

/** Store rows win read-state; inbox/share events fill missing click-through ids. */
function mergeRoutingFields(
  storeRow: Record<string, unknown>,
  mapped: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...storeRow,
    actorPersonUid:
      asString(storeRow.actorPersonUid) || asString(mapped.actorPersonUid),
    targetRef: asString(storeRow.targetRef) || asString(mapped.targetRef),
  };
}

/**
 * Merge NOTIF store + DM inbox + shared-with-me. Store rows of type dm /
 * file_share win when sourceEventId matches an inbox/share eventId.
 *
 * Unread is store-only. Inbox / share events that are not already in the
 * NOTIF store are history fill — they do not light the bell. v1 inbox rows
 * rarely have acknowledgedAt, so treating them as unread made the dot
 * stick after every old DM/share.
 */
export function composeLiveNotifications(args: {
  store?: unknown;
  inbox?: unknown;
  shares?: unknown;
  files?: unknown;
  local?: Record<string, unknown>[];
  unreadOnly?: boolean;
}): ComposedNotificationsFeed {
  const store = storeFeed(args.store);
  const bySource = new Map<string, Record<string, unknown>>();
  const extras: Record<string, unknown>[] = [];

  for (const row of store.rows) {
    const kind = liveSourceKind(asString(row.type));
    if (!kind) {
      extras.push(row);
      continue;
    }
    const source = asString(row.sourceEventId);
    if (source) bySource.set(`${kind}:${source}`, row);
    else extras.push(row);
  }

  for (const event of eventList(args.inbox)) {
    const mapped = mapInboxEventToNotification(event);
    if (!mapped) continue;
    const source = asString(mapped.sourceEventId);
    if (source && bySource.has(`dm:${source}`)) {
      bySource.set(
        `dm:${source}`,
        mergeRoutingFields(bySource.get(`dm:${source}`)!, mapped),
      );
      continue;
    }
    extras.push({ ...mapped, status: "read" });
  }

  for (const event of eventList(args.shares)) {
    const mapped = mapShareEventToNotification(event);
    if (!mapped) continue;
    const source = asString(mapped.sourceEventId);
    if (source && bySource.has(`file_share:${source}`)) {
      bySource.set(
        `file_share:${source}`,
        mergeRoutingFields(bySource.get(`file_share:${source}`)!, mapped),
      );
      continue;
    }
    extras.push({ ...mapped, status: "read" });
  }

  for (const event of fileList(args.files)) {
    const mapped = mapFileHistoryToNotification(event);
    if (!mapped) continue;
    const source = asString(mapped.sourceEventId);
    // A store row for the same event wins, exactly as for DM and share rows —
    // if the server ever emits new_file into NOTIF, its read state governs and
    // the history row is absorbed rather than duplicated.
    if (source && bySource.has(`new_file:${source}`)) {
      bySource.set(
        `new_file:${source}`,
        mergeRoutingFields(bySource.get(`new_file:${source}`)!, mapped),
      );
      continue;
    }
    extras.push(mapped);
  }

  const durableSources = new Set(store.rows.map(row => asString(row.sourceEventId)).filter(Boolean));
  const local = (args.local ?? []).filter(row => !asString(row.sourceEventId) || !durableSources.has(asString(row.sourceEventId)));
  const merged = [...local, ...bySource.values(), ...extras];
  const unreadCount = store.unreadCount === null
    ? merged.filter(isUnreadRow).length
    : store.unreadCount + local.filter(isUnreadRow).length;
  const notifications = args.unreadOnly ? merged.filter(isUnreadRow) : merged;

  return { notifications, unreadCount, nextCursor: store.nextCursor };
}

function isAuthFailure(result: AdapterResult<unknown>): boolean {
  if (result.ok) return false;
  const code = (result.code ?? "").toLowerCase();
  return (
    code.includes("401") ||
    code.includes("403") ||
    code.includes("unauth") ||
    /401|403|unauth/i.test(result.message ?? "")
  );
}

function unwrapMessage(result: AdapterResult<unknown>): string {
  if (result.ok) return "";
  return result.code
    ? `[${result.code}] ${result.message ?? result.reason}`
    : (result.message ?? result.reason);
}

/**
 * Host-facing NotificationsApi that reads the NOTIF store plus the v1 DM
 * and share inboxes, and routes ack to the matching endpoint.
 */
export function createLiveNotificationsApi(
  adapter: PlatformAdapter,
  options: LiveNotificationsOptions = {},
): NotificationsApi {
  const sourceById = new Map<
    string,
    { ack: NotificationAckTarget; sourceEventId: string | null; type: string }
  >();

  function remember(rows: Record<string, unknown>[]): void {
    sourceById.clear();
    for (const row of rows) {
      const id = asString(row.id);
      if (!id) continue;
      const type = liveSourceKind(asString(row.type)) ?? asString(row.type);
      const sourceEventId = asString(row.sourceEventId) || null;
      sourceById.set(id, {
        ack: classifyNotificationAck(id),
        sourceEventId,
        type,
      });
    }
  }

  async function ackOne(id: string): Promise<void> {
    const remembered = sourceById.get(id);
    const target = remembered?.ack ?? classifyNotificationAck(id);
    if (target.kind === "inbox") {
      const r = await adapter.notifications.ackDmInbox([target.eventId]);
      if (!r.ok) throw new Error(unwrapMessage(r));
      return;
    }
    if (target.kind === "share") {
      const r = await adapter.notifications.ackSharedWithMe([target.eventId]);
      if (!r.ok) throw new Error(unwrapMessage(r));
      return;
    }
    if (target.kind === "file") {
      // No ack endpoint, and the row was never unread. Nothing to persist.
      return;
    }
    if (target.kind === "local") {
      options.ackLocalNotification?.(target.id);
      return;
    }
    const store = await adapter.notifications.ack(target.id);
    if (!store.ok) throw new Error(unwrapMessage(store));
    const sourceEventId = remembered?.sourceEventId;
    if (!sourceEventId) return;
    if (remembered?.type === "dm") {
      await adapter.notifications.ackDmInbox([sourceEventId]);
    } else if (remembered?.type === "file_share") {
      await adapter.notifications.ackSharedWithMe([sourceEventId]);
    }
  }

  return {
    fetchNotifications: async (args) => {
      const qs = {
        limit: args.limit,
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.unreadOnly ? { unreadOnly: true } : {}),
      };
      // fetchFileHistory is optional on the adapter, and new-file rows are
      // history rather than alerts. A host without it, or a server too old to
      // answer, must still render DMs and shares — so this source never joins
      // the auth check and never participates in the all-sources-failed throw.
      const fileHistory = adapter.notifications.fetchFileHistory;
      const [store, inbox, shares, files] = await Promise.all([
        adapter.notifications.fetchNotifications(qs),
        adapter.notifications.fetchDmInbox({ limit: args.limit }),
        adapter.notifications.fetchSharedWithMe({ limit: args.limit }),
        fileHistory
          ? fileHistory.call(adapter.notifications, { limit: args.limit })
          : Promise.resolve(null),
      ]);
      if (
        isAuthFailure(store) ||
        isAuthFailure(inbox) ||
        isAuthFailure(shares)
      ) {
        const failed = [store, inbox, shares].find(
          (r) => !r.ok && isAuthFailure(r),
        )!;
        throw new Error(unwrapMessage(failed));
      }
      if (!store.ok && !inbox.ok && !shares.ok) {
        throw new Error(unwrapMessage(store));
      }
      const composed = composeLiveNotifications({
        store: store.ok ? store.value : null,
        inbox: inbox.ok ? inbox.value : null,
        shares: shares.ok ? shares.value : null,
        files: files && files.ok ? files.value : null,
        local: options.localNotifications?.() ?? [],
        unreadOnly: Boolean(args.unreadOnly),
      });
      remember(composed.notifications);
      return composed;
    },
    ackNotification: (id) => ackOne(id),
    readAllNotifications: async () => {
      const ids = [...sourceById.keys()];
      const inboxIds: string[] = [];
      const shareIds: string[] = [];
      let hasLocal = false;
      for (const id of ids) {
        const remembered = sourceById.get(id);
        const target = remembered?.ack ?? classifyNotificationAck(id);
        if (target.kind === "inbox") inboxIds.push(target.eventId);
        else if (target.kind === "share") shareIds.push(target.eventId);
        else if (target.kind === "local") hasLocal = true;
        if (remembered?.sourceEventId && remembered.ack.kind === "store") {
          if (remembered.type === "dm") inboxIds.push(remembered.sourceEventId);
          if (remembered.type === "file_share") {
            shareIds.push(remembered.sourceEventId);
          }
        }
      }
      // Store read-all is the bell source of truth. Inbox/share acks are
      // best-effort so a 404 there cannot roll back a successful mark-all.
      const store = await adapter.notifications.readAll();
      if (!store.ok) throw new Error(unwrapMessage(store));
      const extras: Promise<AdapterResult<unknown>>[] = [];
      if (inboxIds.length > 0) {
        extras.push(adapter.notifications.ackDmInbox([...new Set(inboxIds)]));
      }
      if (shareIds.length > 0) {
        extras.push(
          adapter.notifications.ackSharedWithMe([...new Set(shareIds)]),
        );
      }
      if (hasLocal) options.readAllLocalNotifications?.();
      if (extras.length === 0) return;
      const results = await Promise.all(extras);
      for (const result of results) {
        if (!result.ok) {
          console.warn(
            "notifications: secondary inbox/share ack after read-all failed",
            unwrapMessage(result),
          );
        }
      }
    },
    runNotificationAction: async (args) => {
      const r = await adapter.notifications.runAction(
        args.id,
        args.actionKind,
        args.actionRef,
      );
      if (!r.ok) throw new Error(unwrapMessage(r));
      return r.value;
    },
    // Quick reply from a notification row. Rejects on failure so the row keeps
    // the typed draft visible for a retry — resolving would eat the message.
    sendDm: async ({ toPersonUid, body }) => {
      const r = await adapter.messaging.sendDm(toPersonUid, body);
      if (!r.ok) throw new Error(unwrapMessage(r));
    },
  };
}
