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
export const LIVE_NOTIFICATION_TYPES = ["dm", "file_share"] as const;

export type LiveNotificationType = (typeof LIVE_NOTIFICATION_TYPES)[number];

export const DM_ID_PREFIX = "dm:";
export const SHARE_ID_PREFIX = "share:";

export type NotificationAckTarget =
  | { kind: "store"; id: string }
  | { kind: "inbox"; eventId: string }
  | { kind: "share"; eventId: string };

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

function storeRows(raw: unknown): Record<string, unknown>[] {
  if (!isRecord(raw) || !Array.isArray(raw.notifications)) return [];
  return raw.notifications.filter(isRecord);
}

function eventList(raw: unknown): Record<string, unknown>[] {
  if (!isRecord(raw) || !Array.isArray(raw.events)) return [];
  return raw.events.filter(isRecord);
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
  unreadOnly?: boolean;
}): ComposedNotificationsFeed {
  const bySource = new Map<string, Record<string, unknown>>();
  const extras: Record<string, unknown>[] = [];

  for (const row of storeRows(args.store)) {
    const kind = liveSourceKind(asString(row.type));
    if (!kind) continue;
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

  const merged = [...bySource.values(), ...extras];
  const unreadCount = merged.filter(isUnreadRow).length;
  const notifications = args.unreadOnly ? merged.filter(isUnreadRow) : merged;

  return { notifications, unreadCount, nextCursor: null };
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
        limit: String(args.limit),
        ...(args.cursor ? { cursor: args.cursor } : {}),
        ...(args.unreadOnly ? { unreadOnly: "true" } : {}),
      };
      const [store, inbox, shares] = await Promise.all([
        adapter.notifications.fetchNotifications(qs),
        adapter.notifications.fetchDmInbox({ limit: String(args.limit) }),
        adapter.notifications.fetchSharedWithMe({ limit: String(args.limit) }),
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
      for (const id of ids) {
        const remembered = sourceById.get(id);
        const target = remembered?.ack ?? classifyNotificationAck(id);
        if (target.kind === "inbox") inboxIds.push(target.eventId);
        else if (target.kind === "share") shareIds.push(target.eventId);
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
      const r = await adapter.notifications.runAction(args.id, args.actionKind);
      if (!r.ok) throw new Error(unwrapMessage(r));
      return r.value;
    },
  };
}
