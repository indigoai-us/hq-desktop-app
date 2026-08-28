/**
 * Pure model for the desktop Notifications view (US-012).
 *
 * Maps hq-pro NOTIF store rows into day-grouped view-models, drives the
 * All | Unread filter, optimistic ack / read-all reducers, badge text, and
 * action-button labels. No Svelte / Tauri — unit-tested.
 *
 * Day labels reuse {@link dayKey} / {@link dayLabel} from the shared
 * notificationGroups helper (Today / Yesterday / date).
 */

import { dayKey, dayLabel } from "./notification-groups";

// ── Display taxonomy ─────────────────────────────────────────────────────────

/**
 * UI-facing notification kinds. Server `type` strings map into these; unknown
 * values fall through to `generic` with a safe icon.
 */
export type NotificationDisplayKind =
  | "mention"
  | "agent_finished_story"
  | "agent_review_request"
  | "file_shared"
  | "dm_received"
  | "infra_flag"
  | "generic";

/** Icon key rendered beside each row (view maps to SVG). */
export type NotificationTypeIcon =
  "mention" | "agent" | "review" | "file" | "dm" | "flag" | "generic";

export type NotificationStatus = "unread" | "read";

export type NotificationsFilter = "all" | "unread";

export interface NotificationActionButton {
  /** Stable button id for {#each} / disabled tracking. */
  id: string;
  label: string;
  /** Server actionKind posted on click. */
  actionKind: string;
  variant: "primary" | "secondary" | "danger";
}

/** View-model for one feed row. */
export interface NotificationItem {
  id: string;
  /** Raw server type (kept for debugging / future routing). */
  serverType: string;
  displayKind: NotificationDisplayKind;
  typeIcon: NotificationTypeIcon;
  actorName: string;
  actorInitials: string;
  /** Bold actor + verb phrasing, e.g. "Ada mentioned you". */
  verbText: string;
  /** Secondary context line (body / title / context). */
  contextLine: string;
  status: NotificationStatus;
  createdAt: string;
  createdAtMs: number;
  /** Short clock / relative timestamp for the row. */
  timestampLabel: string;
  actionKind: string | null;
  actionRef: string | null;
  actionButtons: NotificationActionButton[];
  targetRef: string | null;
  /** Actor person uid when the server sent one (DM / share click-through). */
  actorPersonUid: string | null;
  /** Originating DM_EVENT / SHARE_EVENT id, when the store row carries it. */
  sourceEventId: string | null;
  /** True after an inline action has been used (button disabled). */
  actionUsed: boolean;
}

export interface NotificationsDayGroup {
  key: string;
  label: string;
  items: NotificationItem[];
}

/** Client-side feed state owned by the view (optimistic reducers). */
export interface NotificationsFeedState {
  items: NotificationItem[];
  unreadCount: number;
  nextCursor: string | null;
  filter: NotificationsFilter;
}

// ── Wire shape (defensive) ───────────────────────────────────────────────────

export interface NotificationWire {
  id?: unknown;
  type?: unknown;
  status?: unknown;
  readAt?: unknown;
  createdAt?: unknown;
  actorName?: unknown;
  actorPersonUid?: unknown;
  title?: unknown;
  body?: unknown;
  context?: unknown;
  targetRef?: unknown;
  actionRef?: unknown;
  actionKind?: unknown;
  actionable?: unknown;
  companyUid?: unknown;
  sourceEventId?: unknown;
}

export interface NotificationsResponseWire {
  notifications?: unknown;
  unreadCount?: unknown;
  nextCursor?: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asStatus(value: unknown): NotificationStatus {
  if (typeof value === "string" && value.trim().toLowerCase() === "read") {
    return "read";
  }
  return "unread";
}

function parseCreatedAtMs(iso: string | null): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** Two-letter initials from a display name (fallback "?"). */
export function actorInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]![0] ?? ""}${words[1]![0] ?? ""}`.toUpperCase() || "?";
  }
  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase() || "?";
  }
  return "?";
}

/**
 * Map a server `type` string into the UI taxonomy.
 *
 * Catalog includes: dm, file_share, membership_invite, connection_request,
 * security_alert, agent_channel_action_needed, mention, plus many more.
 * Unknown types → generic (safe icon + verb).
 */
export function mapServerType(
  type: string | null | undefined,
): NotificationDisplayKind {
  const t = (type ?? "").trim().toLowerCase();
  if (!t) return "generic";

  if (t === "mention" || t.includes("mention")) return "mention";

  if (
    t === "agent_finished_story" ||
    t === "agent_story_finished" ||
    t === "story_finished" ||
    (t.includes("agent") &&
      (t.includes("finish") || t.includes("complete") || t.includes("done")))
  ) {
    return "agent_finished_story";
  }

  if (
    t === "agent_review_request" ||
    t === "agent_channel_action_needed" ||
    t === "agent_owner_invite" ||
    t === "creator_application" ||
    (t.includes("agent") &&
      (t.includes("review") || t.includes("action_needed"))) ||
    t.includes("action_needed")
  ) {
    return "agent_review_request";
  }

  if (
    t === "file_share" ||
    t === "file_shared" ||
    t.includes("file_share") ||
    t === "share"
  ) {
    return "file_shared";
  }

  if (t === "dm" || t === "dm_received" || t === "message")
    return "dm_received";

  if (
    t === "security_alert" ||
    t === "infra_flag" ||
    t === "infra" ||
    t.includes("security") ||
    t.includes("infra") ||
    t.includes("alert")
  ) {
    return "infra_flag";
  }

  // Connection / membership / sponsorship are still generic rows with actions.
  return "generic";
}

export function typeIconForKind(
  kind: NotificationDisplayKind,
): NotificationTypeIcon {
  switch (kind) {
    case "mention":
      return "mention";
    case "agent_finished_story":
      return "agent";
    case "agent_review_request":
      return "review";
    case "file_shared":
      return "file";
    case "dm_received":
      return "dm";
    case "infra_flag":
      return "flag";
    default:
      return "generic";
  }
}

/**
 * Verb phrase after the actor name. Examples:
 *   "mentioned you" / "finished a story" / "shared a file"
 */
export function verbForKind(
  kind: NotificationDisplayKind,
  serverType: string,
  title?: string | null,
): string {
  switch (kind) {
    case "mention":
      return "mentioned you";
    case "agent_finished_story":
      return "finished a story";
    case "agent_review_request":
      return "requested review";
    case "file_shared":
      return "shared a file";
    case "dm_received":
      return "sent a message";
    case "infra_flag":
      return "flagged infrastructure";
    default: {
      // Prefer a short human title when present; else a neutral verb.
      const t = (title ?? "").trim();
      if (t) return t;
      const st = serverType.trim().replace(/_/g, " ");
      return st || "sent a notification";
    }
  }
}

/** Build the bold primary line: "Ada mentioned you". */
export function formatVerbLine(actorName: string, verb: string): string {
  const actor = actorName.trim() || "Someone";
  const v = verb.trim();
  if (!v) return actor;
  // If verb already starts with the actor (title-as-verb path), don't double.
  if (v.toLowerCase().startsWith(actor.toLowerCase())) return v;
  return `${actor} ${v}`;
}

/**
 * Action buttons derived from actionKind (+ type for multi-button pairs).
 * Empty when there is no actionable kind.
 */
export function actionButtonsFor(
  actionKind: string | null | undefined,
  serverType?: string | null,
): NotificationActionButton[] {
  const kind = (actionKind ?? "").trim();
  if (!kind) return [];

  const k = kind.toLowerCase();
  const type = (serverType ?? "").trim().toLowerCase();

  if (k === "connection_accept" || type === "connection_request") {
    return [
      {
        id: "connection_accept",
        label: "Accept",
        actionKind: "connection_accept",
        variant: "primary",
      },
      {
        id: "connection_decline",
        label: "Decline",
        actionKind: "connection_decline",
        variant: "secondary",
      },
    ];
  }

  if (k === "membership_accept" || type === "membership_invite") {
    return [
      {
        id: "membership_accept",
        label: "Accept",
        actionKind: "membership_accept",
        variant: "primary",
      },
    ];
  }

  if (k === "agent_owner_approve") {
    return [
      {
        id: "agent_owner_approve",
        label: "Approve",
        actionKind: "agent_owner_approve",
        variant: "primary",
      },
    ];
  }

  if (k === "sponsorship_approve" || k === "sponsorship_decline") {
    return [
      {
        id: "sponsorship_approve",
        label: "Approve",
        actionKind: "sponsorship_approve",
        variant: "primary",
      },
      {
        id: "sponsorship_decline",
        label: "Decline",
        actionKind: "sponsorship_decline",
        variant: "secondary",
      },
    ];
  }

  if (k === "connection_decline") {
    return [
      {
        id: "connection_decline",
        label: "Decline",
        actionKind: "connection_decline",
        variant: "secondary",
      },
    ];
  }

  if (k === "connection_block") {
    return [
      {
        id: "connection_block",
        label: "Block",
        actionKind: "connection_block",
        variant: "danger",
      },
    ];
  }

  // Generic: Accept / Approve / Decline phrasing from the kind suffix.
  if (k.endsWith("_approve") || k.includes("approve")) {
    return [{ id: k, label: "Approve", actionKind: kind, variant: "primary" }];
  }
  if (k.endsWith("_accept") || k.includes("accept")) {
    return [{ id: k, label: "Accept", actionKind: kind, variant: "primary" }];
  }
  if (k.endsWith("_decline") || k.includes("decline")) {
    return [
      { id: k, label: "Decline", actionKind: kind, variant: "secondary" },
    ];
  }
  if (k.includes("block")) {
    return [{ id: k, label: "Block", actionKind: kind, variant: "danger" }];
  }

  return [{ id: k, label: "Open", actionKind: kind, variant: "primary" }];
}

/** Short clock for the row (e.g. "3:42 PM"); empty when unparseable. */
export function formatTimestampLabel(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  // Same calendar day → time only; else short date.
  try {
    if (dayKey(ms) === dayKey(now)) {
      return d.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
    }
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/**
 * Parse one wire row into a view-model. Malformed rows (no id) return null and
 * are dropped by the list parser.
 */
export function mapNotificationRow(
  raw: unknown,
  now: number = Date.now(),
): NotificationItem | null {
  if (!isRecord(raw)) return null;
  const id = asOptionalString(raw.id);
  if (!id) return null;

  const serverType = asOptionalString(raw.type) ?? "unknown";
  const displayKind = mapServerType(serverType);
  const actorName =
    asOptionalString(raw.actorName) ??
    (displayKind === "infra_flag" ? "System" : "Someone");
  const title = asOptionalString(raw.title);
  const body = asOptionalString(raw.body);
  const context = asOptionalString(raw.context);
  const contextLine = context ?? body ?? title ?? "";
  const verb = verbForKind(displayKind, serverType, title);
  const actionKind = asOptionalString(raw.actionKind);
  const createdAt = asOptionalString(raw.createdAt) ?? "";
  const createdAtMs = parseCreatedAtMs(createdAt);

  return {
    id,
    serverType,
    displayKind,
    typeIcon: typeIconForKind(displayKind),
    actorName,
    actorInitials: actorInitials(actorName),
    verbText: formatVerbLine(actorName, verb),
    contextLine,
    status: asStatus(raw.status),
    createdAt,
    createdAtMs,
    timestampLabel: formatTimestampLabel(createdAt, now),
    actionKind,
    actionRef: asOptionalString(raw.actionRef),
    actionButtons: actionButtonsFor(actionKind, serverType),
    targetRef: asOptionalString(raw.targetRef),
    actorPersonUid: asOptionalString(raw.actorPersonUid),
    sourceEventId: asOptionalString(raw.sourceEventId),
    actionUsed: false,
  };
}

/**
 * Defensively parse a fetch_notifications response. null / malformed → empty.
 * Malformed rows are dropped. unreadCount falls back to counting unread items
 * when the server omits it.
 */
export function parseNotificationsResponse(
  raw: unknown,
  now: number = Date.now(),
): {
  items: NotificationItem[];
  unreadCount: number;
  nextCursor: string | null;
} {
  if (raw == null || !isRecord(raw)) {
    return { items: [], unreadCount: 0, nextCursor: null };
  }

  const list = Array.isArray(raw.notifications) ? raw.notifications : [];
  const items: NotificationItem[] = [];
  for (const row of list) {
    const mapped = mapNotificationRow(row, now);
    if (mapped) items.push(mapped);
  }

  let unreadCount: number;
  if (typeof raw.unreadCount === "number" && Number.isFinite(raw.unreadCount)) {
    unreadCount = Math.max(0, Math.floor(raw.unreadCount));
  } else if (
    typeof raw.unreadCount === "string" &&
    raw.unreadCount.trim() !== ""
  ) {
    const n = Number(raw.unreadCount);
    unreadCount = Number.isFinite(n)
      ? Math.max(0, Math.floor(n))
      : items.filter((i) => i.status === "unread").length;
  } else {
    unreadCount = items.filter((i) => i.status === "unread").length;
  }

  const nextCursor = asOptionalString(raw.nextCursor);

  return { items, unreadCount, nextCursor };
}

/** Apply All | Unread filter. */
export function filterNotifications(
  items: readonly NotificationItem[],
  filter: NotificationsFilter,
): NotificationItem[] {
  if (filter === "unread") {
    return items.filter((i) => i.status === "unread");
  }
  return [...items];
}

/**
 * Partition items (expected newest-first) into day groups with Today /
 * Yesterday / date labels. Mirrors notificationGroups day bucketing.
 */
export function groupNotificationsByDay(
  items: readonly NotificationItem[],
  now: number = Date.now(),
): NotificationsDayGroup[] {
  const groups: NotificationsDayGroup[] = [];
  let curKey: string | null = null;
  let cur: NotificationsDayGroup | null = null;

  // Sort newest-first for stable grouping when callers pass mixed order.
  const sorted = [...items].sort((a, b) => b.createdAtMs - a.createdAtMs);

  for (const item of sorted) {
    const ms = item.createdAtMs || now;
    const key = dayKey(ms);
    if (!cur || curKey !== key) {
      curKey = key;
      cur = { key, label: dayLabel(ms, now), items: [] };
      groups.push(cur);
    }
    cur.items.push(item);
  }

  return groups;
}

/**
 * Bell badge text from unreadCount. Hidden at 0 (returns null), caps at "99+".
 */
/** Unread count from a notifications feed payload (store or composed). */
export function unreadCountFromNotificationsFeed(raw: unknown): number {
  const parsed = parseNotificationsResponse(raw);
  return parsed.unreadCount;
}

export function formatBadgeCount(unreadCount: number): string | null {
  const n = Number.isFinite(unreadCount) ? Math.floor(unreadCount) : 0;
  if (n <= 0) return null;
  if (n > 99) return "99+";
  return String(n);
}

/** Combined header string (legacy). Prefer title + unread subtitle. */
export function formatNotificationsHeader(unreadCount: number): string {
  const n = Number.isFinite(unreadCount)
    ? Math.max(0, Math.floor(unreadCount))
    : 0;
  return `Notifications · ${n} unread`;
}

export function formatNotificationsUnread(unreadCount: number): string {
  const n = Number.isFinite(unreadCount)
    ? Math.max(0, Math.floor(unreadCount))
    : 0;
  return n > 0 ? `${n} unread` : "All caught up";
}

export function emptyFeedState(
  filter: NotificationsFilter = "all",
): NotificationsFeedState {
  return {
    items: [],
    unreadCount: 0,
    nextCursor: null,
    filter,
  };
}

/** Replace feed contents from a successful fetch (preserves filter). */
export function reduceFeedLoaded(
  state: NotificationsFeedState,
  payload: {
    items: NotificationItem[];
    unreadCount: number;
    nextCursor: string | null;
  },
): NotificationsFeedState {
  return {
    ...state,
    items: payload.items,
    unreadCount: payload.unreadCount,
    nextCursor: payload.nextCursor,
  };
}

/**
 * Optimistic single-row ack. Marks the row read and decrements unreadCount
 * when it was unread. Idempotent for already-read rows.
 */
export function reduceAck(
  state: NotificationsFeedState,
  id: string,
): NotificationsFeedState {
  const target = id.trim();
  if (!target) return state;

  let decremented = false;
  const items = state.items.map((item) => {
    if (item.id !== target) return item;
    if (item.status === "read") return item;
    decremented = true;
    return { ...item, status: "read" as const };
  });

  return {
    ...state,
    items,
    unreadCount: decremented
      ? Math.max(0, state.unreadCount - 1)
      : state.unreadCount,
  };
}

/**
 * Optimistic mark-all-read. Zeros unreadCount and flips every row to read.
 */
export function reduceReadAll(
  state: NotificationsFeedState,
): NotificationsFeedState {
  return {
    ...state,
    unreadCount: 0,
    items: state.items.map((item) =>
      item.status === "read" ? item : { ...item, status: "read" as const },
    ),
  };
}

/**
 * Mark inline actions on a row as used (buttons disabled). Also acks the row
 * optimistically when it was unread.
 */
export function reduceActionUsed(
  state: NotificationsFeedState,
  id: string,
): NotificationsFeedState {
  const afterAck = reduceAck(state, id);
  const target = id.trim();
  return {
    ...afterAck,
    items: afterAck.items.map((item) =>
      item.id === target ? { ...item, actionUsed: true } : item,
    ),
  };
}

export function reduceFilter(
  state: NotificationsFeedState,
  filter: NotificationsFilter,
): NotificationsFeedState {
  return { ...state, filter };
}

/** Visible items for the current filter, day-grouped. */
export function buildNotificationsView(
  state: NotificationsFeedState,
  now: number = Date.now(),
): {
  groups: NotificationsDayGroup[];
  headerTitle: string;
  headerUnread: string;
  badgeText: string | null;
  visibleCount: number;
} {
  const visible = filterNotifications(state.items, state.filter);
  return {
    groups: groupNotificationsByDay(visible, now),
    headerTitle: "Notifications",
    headerUnread: formatNotificationsUnread(state.unreadCount),
    badgeText: formatBadgeCount(state.unreadCount),
    visibleCount: visible.length,
  };
}

/**
 * Classify list/fetch errors for absent-safe UI.
 * Missing endpoint → empty state (not an alarming error).
 */
export function classifyNotificationsError(
  err: unknown,
): "unsupported" | "auth" | "generic" {
  const msg = (
    err instanceof Error ? err.message : String(err ?? "")
  ).toLowerCase();
  if (
    msg.includes("404") ||
    msg.includes("not found") ||
    msg.includes("unknown route") ||
    msg.includes("empty_404")
  ) {
    return "unsupported";
  }
  if (
    msg.includes("not signed in") ||
    msg.includes("401") ||
    msg.includes("unauthorized") ||
    msg.includes("auth")
  ) {
    return "auth";
  }
  return "generic";
}

/**
 * Where a row click should go. hq-pro puts an in-console path on
 * `targetRef` (`/messages`, `/messages/prs_*`, `/files`). Work has no
 * console router, so we resolve that onto a DM thread or a files hint.
 */
export type NotificationDestination =
  | { kind: "dm"; personUid: string; title: string }
  | { kind: "files" }
  | { kind: "none" };

export function personUidFromTargetRef(ref: string | null): string | null {
  if (!ref) return null;
  const match = ref.trim().match(/^\/messages\/(prs_[A-Za-z0-9]+)\b/);
  return match?.[1] ?? null;
}

export function notificationDestination(
  item: NotificationItem,
): NotificationDestination {
  const uid =
    item.actorPersonUid?.trim() || personUidFromTargetRef(item.targetRef) || "";
  const target = item.targetRef?.trim() ?? "";
  const isDm =
    item.displayKind === "dm_received" || target.startsWith("/messages");
  const isShare =
    item.displayKind === "file_shared" ||
    target === "/files" ||
    target.startsWith("/files/");

  if (isDm && uid) {
    return {
      kind: "dm",
      personUid: uid,
      title: item.actorName || "Direct message",
    };
  }
  if (isShare && uid) {
    return {
      kind: "dm",
      personUid: uid,
      title: item.actorName || "Shared files",
    };
  }
  if (isShare) return { kind: "files" };
  return { kind: "none" };
}

export const NOTIFICATIONS_EMPTY_MESSAGE = "No notifications yet";
export const NOTIFICATIONS_UNREAD_EMPTY_MESSAGE = "You're all caught up";
export const NOTIFICATIONS_UNSUPPORTED_MESSAGE =
  "Notifications are not available on this server yet";
