/**
 * Pure widget notification stack — queue-on-occlusion + visible stack sizing.
 *
 * Framework-free (no Tauri, no Svelte) so unit tests and the Widget component
 * share the same reducers. Rust emits `widget:notification` / `widget:occlusion`;
 * this module only owns in-memory stack semantics and window size math.
 */
import { automatedAgentJoinNoticeKey } from '../lib/automatedNotices';

/** Auto-collapse timeout for each visible stack row (ms). */
export const WIDGET_ROW_TIMEOUT_MS = 8000;

/** Max visible rows; overflow drops the oldest visible. */
export const WIDGET_STACK_MAX = 4;

/** Idle wordmark window width (logical px) — matches Rust WIDGET_W. */
export const WIDGET_IDLE_WIDTH = 66;

/** Idle wordmark window height (logical px) — matches Rust WIDGET_H. */
export const WIDGET_IDLE_HEIGHT = 43;

/** Comfortable notification row width. */
export const WIDGET_ROW_WIDTH = 348;

/**
 * Window width with a visible stack: row + 20px side slack for hover
 * Open/Dismiss actions that sit at the row edge.
 */
export const WIDGET_STACK_WIDTH = 368;

/** Lower mark area height (idle window height). */
export const WIDGET_MARK_AREA = 43;

/** Gap between the stack column and the wordmark (mockup margin-bottom). */
export const WIDGET_STACK_MARGIN_BOTTOM = 12;

/** Collapsed row height. */
export const WIDGET_ROW_HEIGHT = 48;

/** Vertical gap between stacked rows. */
export const WIDGET_ROW_GAP = 8;

/** Top padding / superscript headroom above the stack. */
export const WIDGET_TOP_HEADROOM = 10;

/**
 * Extra window height when any visible row is type `message` so the
 * NotificationRow hover-expand (body + reply + reacts) fits without clipping.
 */
export const WIDGET_MESSAGE_EXPAND_HEADROOM = 144;

/** Cap for the recent-notification history list (hover + future surfaces). */
export const WIDGET_RECENT_MAX = 20;

/**
 * Max rows shown in the wordmark hover/click popup (US-015).
 *
 * Seven leaves enough room for the orienting header, section labels, and
 * destination footer on a 768px-tall display, including reply-expansion
 * headroom. The full Messages window remains one click away in the footer.
 * Repeated activity and messages collapse before this cap.
 */
export const WIDGET_HOVER_MAX = 7;

/**
 * Ambient activity from one company/source inside this window becomes one
 * compact row. Six hours keeps a working-session burst together without
 * flattening separate days into one opaque notification.
 */
export const WIDGET_ACTIVITY_BURST_WINDOW_MS = 6 * 60 * 60 * 1000;

/** localStorage key for persisted widget recent history (US-015). */
export const WIDGET_RECENT_STORAGE_KEY = 'hq-widget-recent-v1';

/** Collapsed one-line row height in the mini communications panel. */
export const WIDGET_HOVER_ROW_HEIGHT = 32;

/** Day-separator row height in the hover list. */
export const WIDGET_HOVER_SEPARATOR_HEIGHT = 22;

/** Frosted popup panel width. */
export const WIDGET_HOVER_PANEL_WIDTH = 364;

/** Gap between popup rows. */
export const WIDGET_HOVER_ROW_GAP = 1;

/** Vertical padding inside the hover frosted panel. */
export const WIDGET_HOVER_LIST_PADDING = 18;

/** Orienting title and summary above mini-window conversations. */
export const WIDGET_HOVER_HEADER_HEIGHT = 32;

/**
 * Footer toolbar height inside the hover popup (Inbox + Desktop icon actions).
 * Includes top hairline gap + icon row + bottom pad.
 */
export const WIDGET_HOVER_FOOTER_HEIGHT = 36;

/** NotificationRow-compatible type strings. */
export type WidgetRowType =
  | 'message'
  | 'mention'
  | 'share'
  | 'sync'
  | 'deploy'
  | 'system';

/**
 * Banner payload shape emitted on `widget:notification` (camelCase JSON from
 * Rust `BannerPayload`). Keep loose so tests can pass partials.
 */
export interface BannerPayloadLike {
  kind: string;
  title: string;
  body: string;
  iconText?: string | null;
  actionLabel?: string | null;
  actionId?: string | null;
  clickActionId: string;
  data: unknown;
}

/** One item in the widget visible or queued stack. */
export interface WidgetStackItem {
  id: string;
  type: WidgetRowType;
  actor?: string;
  text: string;
  /** Epoch ms — for NotificationRow relative timestamp. */
  ts: number;
  /** Original banner kind (`dm` | `share` | `meeting` | `update` | …). */
  kind: string;
  clickActionId: string;
  data: unknown;
  /**
   * Optional chip action id from the banner payload. Kept separate from the
   * row-body Open destination.
   */
  actionId?: string | null;
  /**
   * Optional chip action label from the banner payload.
   */
  actionLabel?: string | null;
  /** Non-privileged identity used to preserve read state across trusted refreshes. */
  updateVersion?: string;
  /** Epoch ms — visible items with `expiresAt <= now` are dropped. */
  expiresAt: number;
  /** Unread marker for recent/hover list (set true on addItem). */
  unread?: boolean;
  /** Derived compact-panel member ids. Never persisted or used by full Inbox. */
  compactGroupIds?: string[];
  /** Derived compact-panel count. Omitted for a normal, ungrouped row. */
  compactGroupCount?: number;
  /** Unread members represented by a compact conversation/activity row. */
  compactGroupUnreadCount?: number;
}

/** Minimal channel shape used to surface unread channels in the widget. */
export interface WidgetChannelLike {
  channelId: string;
  name: string;
  scope: string;
  companyName?: string | null;
  memberCount?: number;
  members?: Array<{ displayName?: string | null }>;
  unread?: number;
  lastActivityAt?: string | null;
  lastMessageAt?: string | null;
  createdAt?: string | null;
}

function widgetChannelName(channel: WidgetChannelLike): string {
  const name = channel.name.trim().replace(/^#+/, '');
  if (name) return name;
  const members = (channel.members ?? [])
    .map((member) => member.displayName?.trim())
    .filter((member): member is string => Boolean(member));
  if (members.length > 0) {
    const shown = members.slice(0, 3);
    const extra = members.length - shown.length;
    return extra > 0 ? `${shown.join(', ')} +${extra}` : shown.join(', ');
  }
  return channel.memberCount ? `Group · ${channel.memberCount}` : 'Group DM';
}

function widgetChannelTimestamp(channel: WidgetChannelLike, now: number): number {
  for (const value of [
    channel.lastMessageAt,
    channel.lastActivityAt,
    channel.createdAt,
  ]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now;
}

/**
 * Convert an unread channel into a trusted, openable mini-window row.
 *
 * The current native channel event carries only an id and unread count, so the
 * widget refreshes `list_channels` and renders honest channel context rather
 * than inventing a sender or preview that the payload does not contain.
 */
export function channelToStackItem(
  channel: WidgetChannelLike,
  now: number,
): WidgetStackItem {
  const unread = Math.max(0, channel.unread ?? 0);
  const groupDm = channel.scope === 'group';
  const name = widgetChannelName(channel);
  const context = groupDm
    ? channel.memberCount
      ? `Group DM · ${channel.memberCount} people`
      : 'Group DM'
    : channel.companyName?.trim() ||
      (channel.scope === 'personal' ? 'Personal channel' : 'Channel');

  return {
    id: `channel:${channel.channelId}`,
    type: 'mention',
    actor: groupDm ? name : `#${name}`,
    text: `${unread} unread · ${context}`,
    ts: widgetChannelTimestamp(channel, now),
    kind: 'channel',
    clickActionId: 'open-channel',
    data: channel,
    expiresAt: 0,
    unread: unread > 0,
  };
}

/** Full stack state owned by Widget.svelte. */
export interface WidgetStackState {
  visible: WidgetStackItem[];
  queued: WidgetStackItem[];
  /** Newest-first recent history (includes items that also sit in visible/queued). */
  recent: WidgetStackItem[];
  occluded: boolean;
  /**
   * Pointer-over / reply-draft hold: when true, auto-collapse is suspended
   * (see {@link expireItems}) so a notification under the pointer or mid-reply
   * never disappears. Omitted/`undefined` is treated as false.
   */
  held?: boolean;
}

/** Empty non-occluded stack. */
export function emptyWidgetStack(): WidgetStackState {
  return { visible: [], queued: [], recent: [], occluded: false, held: false };
}

/**
 * Toggle pointer/reply hold. No-op when `held` is already the requested value.
 * Entering hold only flips the flag (arrays copied like other reducers).
 * Releasing hold clears the flag and refreshes every visible item's
 * `expiresAt` to `now + WIDGET_ROW_TIMEOUT_MS` so timers restart fresh after
 * the pointer leaves / draft is cleared.
 */
export function setHeld(
  state: WidgetStackState,
  held: boolean,
  now: number,
): WidgetStackState {
  const wasHeld = state.held === true;
  if (held === wasHeld) {
    return state;
  }
  if (held) {
    return {
      ...state,
      held: true,
      visible: state.visible.slice(),
      queued: state.queued.slice(),
      recent: state.recent.slice(),
    };
  }
  return {
    ...state,
    held: false,
    visible: state.visible.map((item) => ({
      ...item,
      expiresAt: now + WIDGET_ROW_TIMEOUT_MS,
    })),
    queued: state.queued.slice(),
    recent: state.recent.slice(),
  };
}

/**
 * Map a banner payload into a stack item.
 * kind → row type: dm→message, share→share, update/meeting/unknown→system.
 */
export function bannerToStackItem(
  payload: BannerPayloadLike,
  now: number,
  id: string,
): WidgetStackItem {
  const kind = payload.kind ?? 'system';
  let type: WidgetRowType;
  let actor: string | undefined;
  let text: string;

  switch (kind) {
    case 'dm':
      type = 'message';
      actor = payload.title;
      text = payload.body ?? '';
      break;
    case 'share':
      type = 'share';
      actor = payload.title;
      text = payload.body ?? '';
      break;
    case 'update':
    case 'meeting':
    default:
      type = 'system';
      text = joinTitleBody(payload.title, payload.body);
      break;
  }

  const updateVersion =
    kind === 'update' &&
    payload.data !== null &&
    typeof payload.data === 'object' &&
    'version' in payload.data &&
    typeof payload.data.version === 'string'
      ? payload.data.version
      : undefined;

  return {
    id: updateVersion ? `update:${updateVersion}` : id,
    type,
    actor,
    text,
    ts: now,
    kind,
    clickActionId: payload.clickActionId,
    data: payload.data,
    actionId: payload.actionId,
    actionLabel: payload.actionLabel,
    updateVersion,
    expiresAt: now + WIDGET_ROW_TIMEOUT_MS,
  };
}

function joinTitleBody(title: string, body: string | undefined): string {
  const t = (title ?? '').trim();
  const b = (body ?? '').trim();
  if (t && b) return `${t} — ${b}`;
  return t || b;
}

/** Prepend into recent history: unread, dedupe by id, trim to max. */
function prependRecent(recent: WidgetStackItem[], item: WidgetStackItem): WidgetStackItem[] {
  const entry: WidgetStackItem = { ...item, unread: true };
  return [entry, ...recent.filter((r) => r.id !== item.id)].slice(0, WIDGET_RECENT_MAX);
}

/**
 * Enqueue or show a notification. When occluded, push onto `queued` (newest
 * first); otherwise prepend to `visible` and trim to {@link WIDGET_STACK_MAX}.
 * Always also prepends into `recent` (unread, deduped, capped).
 */
export function addItem(state: WidgetStackState, item: WidgetStackItem): WidgetStackState {
  // The updater may rediscover the same version every six hours. Keep one
  // current update row instead of accumulating random banner ids.
  const isActionableUpdate =
    item.kind === 'update' &&
    (item.actionId === 'update' ||
      (item.data !== null &&
        typeof item.data === 'object' &&
        'version' in item.data));
  const base =
    isActionableUpdate
      ? {
          ...state,
          visible: state.visible.filter((entry) => entry.kind !== 'update'),
          queued: state.queued.filter((entry) => entry.kind !== 'update'),
          recent: state.recent.filter((entry) => entry.kind !== 'update'),
        }
      : state;
  const recent = prependRecent(base.recent, item);
  if (base.occluded) {
    return {
      ...base,
      visible: base.visible.slice(),
      queued: [item, ...base.queued],
      recent,
    };
  }
  return {
    ...base,
    queued: base.queued.slice(),
    visible: [item, ...base.visible].slice(0, WIDGET_STACK_MAX),
    recent,
  };
}

/**
 * Update occlusion. On occluded→visible, flush `queued` into `visible`
 * (newest on top, trim to max) and refresh each flushed item's `expiresAt`
 * so queued items still get a full display window.
 */
export function setOccluded(
  state: WidgetStackState,
  occluded: boolean,
  now: number,
): WidgetStackState {
  if (occluded) {
    return {
      ...state,
      occluded: true,
      visible: state.visible.slice(),
      queued: state.queued.slice(),
      recent: state.recent.slice(),
    };
  }

  // Already clear — no flush.
  if (!state.occluded) {
    return {
      ...state,
      occluded: false,
      visible: state.visible.slice(),
      queued: state.queued.slice(),
      recent: state.recent.slice(),
    };
  }

  const flushed = state.queued.map((item) => ({
    ...item,
    expiresAt: now + WIDGET_ROW_TIMEOUT_MS,
  }));
  // Queued is newest-first; keep those above any still-visible rows.
  const visible = [...flushed, ...state.visible].slice(0, WIDGET_STACK_MAX);
  return {
    ...state,
    occluded: false,
    visible,
    queued: [],
    recent: state.recent.slice(),
  };
}

/**
 * Drop visible items whose `expiresAt <= now`. Queued/recent are untouched.
 * No-op while `held` — auto-collapse is suspended under the pointer / mid-reply.
 */
export function expireItems(state: WidgetStackState, now: number): WidgetStackState {
  if (state.held === true) {
    return state;
  }
  const visible = state.visible.filter((item) => item.expiresAt > now);
  if (visible.length === state.visible.length) {
    return state;
  }
  return {
    ...state,
    visible,
    queued: state.queued.slice(),
    recent: state.recent.slice(),
  };
}

/** Remove an item from visible and queued by id. Recent history is kept. */
export function dismissItem(state: WidgetStackState, id: string): WidgetStackState {
  return {
    ...state,
    visible: state.visible.filter((item) => item.id !== id),
    queued: state.queued.filter((item) => item.id !== id),
    recent: state.recent.slice(),
  };
}

/** Remove an item from recent and visible by id. Queued is kept. */
export function dismissRecent(state: WidgetStackState, id: string): WidgetStackState {
  return {
    ...state,
    visible: state.visible.filter((item) => item.id !== id),
    queued: state.queued.slice(),
    recent: state.recent.filter((item) => item.id !== id),
  };
}

/**
 * Clear the queued stack after the user has seen it via the hover list.
 * Items remain in `recent`. No-op when queued is already empty.
 */
export function markQueueSeen(state: WidgetStackState): WidgetStackState {
  if (state.queued.length === 0) {
    return state;
  }
  return {
    ...state,
    visible: state.visible.slice(),
    queued: [],
    recent: state.recent.slice(),
  };
}

/**
 * Mark every recent item as read (unread=false). No-op when none are unread.
 */
export function markRecentRead(state: WidgetStackState): WidgetStackState {
  if (!state.recent.some((r) => r.unread)) {
    return state;
  }
  return {
    ...state,
    visible: state.visible.slice(),
    queued: state.queued.slice(),
    recent: state.recent.map((r) => (r.unread ? { ...r, unread: false } : r)),
  };
}

/**
 * Count of recent items still marked unread. Drives the wordmark superscript
 * when the recent list has been viewed (mark-on-leave watermark).
 */
export function unreadRecentCount(state: WidgetStackState): number {
  return state.recent.filter((r) => r.unread === true).length;
}

/**
 * Rows for the wordmark hover list: recent (already includes queued+visible via
 * addItem), newest first, capped to {@link WIDGET_HOVER_MAX}.
 * Inclusion is independent of read/unread (US-015 history semantics).
 */
export function hoverItems(state: WidgetStackState): WidgetStackItem[] {
  return state.recent.slice(0, WIDGET_HOVER_MAX);
}

function compactActivityContext(item: WidgetStackItem): string | null {
  const record =
    item.data && typeof item.data === 'object' && !Array.isArray(item.data)
      ? (item.data as Record<string, unknown>)
      : null;
  const source =
    record?.company ??
    record?.companySlug ??
    record?.company_slug ??
    record?.companyName ??
    record?.workspace ??
    record?.repo ??
    record?.source ??
    '';
  const normalized = String(source).trim().toLocaleLowerCase();
  return normalized ? normalized : null;
}

function compactAutomatedDmKey(item: WidgetStackItem): string | null {
  const data =
    item.data && typeof item.data === 'object' && !Array.isArray(item.data)
      ? (item.data as Record<string, unknown>)
      : null;
  return automatedAgentJoinNoticeKey({
    kind: item.kind,
    body: typeof data?.body === 'string' ? data.body : item.text,
    fromPersonUid:
      typeof data?.fromPersonUid === 'string' ? data.fromPersonUid : null,
    fromEmail: typeof data?.fromEmail === 'string' ? data.fromEmail : null,
    fromDisplayName:
      typeof data?.fromDisplayName === 'string'
        ? data.fromDisplayName
        : item.actor,
    details: typeof data?.details === 'string' ? data.details : null,
    prompt: typeof data?.prompt === 'string' ? data.prompt : null,
  });
}

/**
 * Stable conversation identity for the mini messages window.
 *
 * Native history carries a person UID; older/persisted rows may only retain
 * email, display name, or the visible actor. This projection is deliberately
 * scoped to the compact widget: the full Inbox keeps every individual event.
 */
function compactDmConversationKey(item: WidgetStackItem): string | null {
  if (item.kind !== 'dm' || item.type !== 'message') return null;
  const data =
    item.data && typeof item.data === 'object' && !Array.isArray(item.data)
      ? (item.data as Record<string, unknown>)
      : null;
  for (const value of [
    data?.fromPersonUid,
    data?.fromEmail,
    data?.fromDisplayName,
    item.actor,
  ]) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLocaleLowerCase();
    if (normalized) return normalized;
  }
  return null;
}

function sameLocalDay(a: number, b: number): boolean {
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

/**
 * Collapse ambient sync/activity bursts for the compact communications panel.
 *
 * Direct messages compact by conversation so one active sender consumes one
 * row instead of turning the mini messages window into an event log. Channels,
 * mentions, shares, updates, meetings, and warnings remain individual.
 * Repeated automated agent-join DMs compact using the same deliberately narrow
 * rule as Inbox. The full audit trail remains in recent history; this helper is
 * only consumed by Widget's mini-window projection.
 */
export function compactActivityBursts(
  items: WidgetStackItem[],
  windowMs = WIDGET_ACTIVITY_BURST_WINDOW_MS,
): WidgetStackItem[] {
  const output: WidgetStackItem[] = [];
  const openClusters = new Map<
    string,
    { outputIndex: number; newestTs: number }
  >();

  for (const item of items) {
    const activityEligible =
      item.type === 'sync' &&
      item.kind !== 'dm' &&
      item.kind !== 'channel' &&
      item.kind !== 'share' &&
      item.kind !== 'update' &&
      item.kind !== 'meeting';
    const automatedDmKey = compactAutomatedDmKey(item);
    const dmConversationKey = compactDmConversationKey(item);
    const activityContext = activityEligible
      ? compactActivityContext(item)
      : null;
    const key = automatedDmKey
      ? `automated-dm:${automatedDmKey}`
      : dmConversationKey
        ? `dm:${dmConversationKey}`
        : activityContext
          ? `activity:${activityContext}`
          : null;
    if (!key) {
      output.push(item);
      continue;
    }

    const cluster = openClusters.get(key);
    if (
      !cluster ||
      cluster.newestTs < item.ts ||
      cluster.newestTs - item.ts > windowMs ||
      !sameLocalDay(cluster.newestTs, item.ts)
    ) {
      openClusters.set(key, {
        outputIndex: output.length,
        newestTs: item.ts,
      });
      output.push(item);
      continue;
    }

    const representative = output[cluster.outputIndex]!;
    const memberIds = representative.compactGroupIds ?? [representative.id];
    const unreadMembers =
      representative.compactGroupUnreadCount ??
      (representative.unread === true ? 1 : 0);
    output[cluster.outputIndex] = {
      ...representative,
      unread: representative.unread === true || item.unread === true,
      compactGroupIds: [...memberIds, item.id],
      compactGroupCount: memberIds.length + 1,
      compactGroupUnreadCount:
        unreadMembers + (item.unread === true ? 1 : 0),
    };
  }

  return output;
}

/**
 * Compact mini-window rows, newest-first. Collapse before applying the visual
 * cap so a seven-file burst consumes one row rather than hiding nine unrelated
 * conversations behind it.
 */
export function compactHoverItems(
  state: WidgetStackState,
): WidgetStackItem[] {
  return compactActivityBursts(state.recent).slice(0, WIDGET_HOVER_MAX);
}

/** Fields persisted for recent history (id, display, action, unread). */
type SerializedRecentItem = {
  id: string;
  type: WidgetRowType;
  actor?: string;
  text: string;
  ts: number;
  kind: string;
  clickActionId: string;
  data: unknown;
  actionId?: string | null;
  actionLabel?: string | null;
  updateVersion?: string;
  expiresAt: number;
  unread: boolean;
};

/**
 * Serialize `state.recent` for localStorage (US-015). Only fields needed to
 * restore the hover history after relaunch.
 */
export function serializeRecent(state: WidgetStackState): string {
  const payload: SerializedRecentItem[] = state.recent.map((item) => ({
    id: item.id,
    type: item.type,
    actor: item.actor,
    text: item.text,
    ts: item.ts,
    kind: item.kind,
    clickActionId: item.clickActionId,
    data: item.data,
    actionId: item.actionId,
    actionLabel: item.actionLabel,
    updateVersion: item.updateVersion,
    expiresAt: item.expiresAt,
    unread: item.unread === true,
  }));
  return JSON.stringify(payload);
}

/**
 * Safe parse of persisted recent history. Never throws.
 * Returns [] on null/invalid JSON/non-array; filters junk entries; caps at
 * {@link WIDGET_RECENT_MAX}.
 *
 * Security: localStorage is an untrusted store — a tampered entry must never
 * drive a privileged Tauri action command. Hydrated rows are display-only:
 * the action surface (`clickActionId`, `data`, `actionId`, `actionLabel`) is
 * stripped on restore, and `Widget.handleOpen` skips the privileged invoke
 * for rows with an empty `clickActionId`.
 */
export function deserializeRecent(
  raw: string | null | undefined,
): WidgetStackItem[] {
  if (raw == null || raw === '') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const out: WidgetStackItem[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || typeof e.text !== 'string' || typeof e.ts !== 'number') {
      continue;
    }
    const type: WidgetRowType =
      e.type === 'message' ||
      e.type === 'mention' ||
      e.type === 'share' ||
      e.type === 'sync' ||
      e.type === 'deploy' ||
      e.type === 'system'
        ? e.type
        : 'system';
    const kind = typeof e.kind === 'string' ? e.kind : 'system';
    const updateVersion =
      kind === 'update' && typeof e.updateVersion === 'string'
        ? e.updateVersion
        : undefined;
    out.push({
      id: updateVersion ? `update:${updateVersion}` : e.id,
      type,
      actor: typeof e.actor === 'string' ? e.actor : undefined,
      text: e.text,
      ts: e.ts,
      kind,
      // Display-only restore — action surface never rehydrated from
      // untrusted storage (see doc comment above). Open is restored by
      // mergeRecentWithHistory after fetch_notification_history on mount.
      clickActionId: '',
      data: null,
      actionId: undefined,
      actionLabel: undefined,
      updateVersion,
      expiresAt: typeof e.expiresAt === 'number' ? e.expiresAt : 0,
      unread: e.unread === true,
    });
    if (out.length >= WIDGET_RECENT_MAX) {
      break;
    }
  }
  return out;
}

/**
 * Minimal feed-item shape used to seed the widget recent list from
 * `fetch_notification_history` (shared with NotificationFeed / Inbox).
 * Kept local to this module so the pure store stays free of Tauri imports.
 */
export type HistoryFeedItem = {
  id: string;
  kind: 'dm' | 'share' | 'new-file' | 'update';
  actor: string;
  summary: string;
  /** Epoch ms. */
  ts: number;
  dm?: unknown;
  share?: unknown;
  file?: { company: string; path: string };
  update?: unknown;
};

/** Basename of a path for compact share/file previews (Lizzie one-line). */
function pathBasename(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
}

/**
 * Map a notification-history feed item into a widget stack row that can Open
 * (clickActionId + source data preserved for handleOpen routing).
 */
export function historyFeedItemToStackItem(
  item: HistoryFeedItem,
  lastReadTs: number,
): WidgetStackItem {
  let type: WidgetRowType;
  let text: string;
  let data: unknown = null;
  let kind: string = item.kind;

  switch (item.kind) {
    case 'dm':
      type = 'message';
      text =
        item.dm && typeof item.dm === 'object' && item.dm !== null && 'body' in item.dm
          ? String((item.dm as { body?: string }).body ?? item.summary)
          : item.summary;
      data = item.dm ?? null;
      break;
    case 'share': {
      type = 'share';
      // Prefer the first shared path basename (matches Lizzie mockup).
      const paths =
        item.share && typeof item.share === 'object' && item.share !== null && 'paths' in item.share
          ? (item.share as { paths?: string[] }).paths
          : undefined;
      text =
        Array.isArray(paths) && paths.length > 0
          ? pathBasename(paths[0]!)
          : item.summary;
      data = item.share ?? null;
      break;
    }
    case 'new-file':
      type = 'sync';
      kind = 'new-file';
      text = item.file?.path ? pathBasename(item.file.path) : item.summary;
      data = item.file ?? null;
      break;
    case 'update':
      type = 'system';
      text = item.summary;
      data = item.update ?? null;
      break;
    default:
      type = 'system';
      text = item.summary;
      break;
  }

  return {
    id: item.id,
    type,
    actor: item.actor || undefined,
    text,
    ts: item.ts,
    kind,
    clickActionId: 'open',
    data,
    actionId: item.kind === 'update' ? 'update' : undefined,
    actionLabel: item.kind === 'update' ? 'Update now' : undefined,
    updateVersion:
      item.kind === 'update' &&
      item.update !== null &&
      typeof item.update === 'object' &&
      'version' in item.update &&
      typeof item.update.version === 'string'
        ? item.update.version
        : undefined,
    expiresAt: 0,
    unread: item.ts > lastReadTs,
  };
}

/**
 * Merge local widget recent history with server notification history.
 *
 * History rows carry openable trusted data. When native update state was
 * resolved, all random-id local update rows are replaced by the single trusted
 * pending row (or removed after a confirmed null). On IPC failure callers leave
 * `updatesAuthoritative` false so a safe display-only local row survives.
 *
 * Newest-first, capped at {@link WIDGET_RECENT_MAX}.
 */
export function mergeRecentWithHistory(
  localRecent: WidgetStackItem[],
  historyItems: WidgetStackItem[],
  options: { updatesAuthoritative?: boolean } = {},
): WidgetStackItem[] {
  const byId = new Map<string, WidgetStackItem>();
  const updatesAuthoritative =
    options.updatesAuthoritative ??
    historyItems.some((item) => item.kind === 'update');
  const trustedUpdates = new Map(
    historyItems
      .filter(
        (item): item is WidgetStackItem & { updateVersion: string } =>
          item.kind === 'update' && typeof item.updateVersion === 'string',
      )
      .map((item) => [item.updateVersion, item]),
  );

  for (const item of localRecent) {
    if (updatesAuthoritative && item.kind === 'update') {
      const trusted =
        typeof item.updateVersion === 'string'
          ? trustedUpdates.get(item.updateVersion)
          : undefined;
      if (trusted) {
        byId.set(trusted.id, { ...item, id: trusted.id });
      }
      continue;
    }
    byId.set(item.id, item);
  }

  for (const item of historyItems) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      continue;
    }
    // Prefer openable history data; preserve unread if either side is unread.
    const unread =
      item.kind === 'update'
        ? existing.unread === true
        : existing.unread === true || item.unread === true;
    const preferHistory =
      (item.data != null && existing.data == null) ||
      (Boolean(item.clickActionId) && !existing.clickActionId) ||
      item.ts >= existing.ts;
    byId.set(item.id, preferHistory ? { ...item, unread } : { ...existing, unread });
  }

  return [...byId.values()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, WIDGET_RECENT_MAX);
}

/**
 * Day label for hover separators. `null` when same calendar day as `now`
 * (TODAY implied), `'YESTERDAY'` for the previous calendar day, else an
 * uppercase short date (`en-US` month + day).
 */
export function dayLabel(ts: number, now: number): string | null {
  const d = new Date(ts);
  const n = new Date(now);
  if (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  ) {
    return null;
  }

  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (
    d.getFullYear() === y.getFullYear() &&
    d.getMonth() === y.getMonth() &&
    d.getDate() === y.getDate()
  ) {
    return 'YESTERDAY';
  }

  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
}

/**
 * Walk hover items (newest first) and attach a day separator the first time the
 * day label changes from the previous row. First row: separator is null when
 * today; otherwise the day label itself.
 */
export function hoverRows(
  items: WidgetStackItem[],
  now: number,
): Array<{ separator: string | null; item: WidgetStackItem }> {
  const out: Array<{ separator: string | null; item: WidgetStackItem }> = [];
  let prevLabel: string | null | undefined;
  for (const item of items) {
    const label = dayLabel(item.ts, now);
    let separator: string | null = null;
    if (prevLabel === undefined) {
      // First row — null when today; label when older.
      separator = label;
    } else if (label !== prevLabel) {
      separator = label;
    }
    out.push({ separator, item });
    prevLabel = label;
  }
  return out;
}

/**
 * Logical window size for the current stack.
 * Idle (no visible rows, regardless of queued): 66×43.
 * With N visible rows: width {@link WIDGET_STACK_WIDTH}, height from mark +
 * stack margin + rows + gaps + top headroom (+ message expand room).
 * Backend clamps to 66..380 × 43..720.
 */
export function widgetWindowSize(state: WidgetStackState): { width: number; height: number } {
  const n = state.visible.length;
  if (n === 0) {
    return { width: WIDGET_IDLE_WIDTH, height: WIDGET_IDLE_HEIGHT };
  }

  let height =
    WIDGET_MARK_AREA +
    WIDGET_STACK_MARGIN_BOTTOM +
    n * WIDGET_ROW_HEIGHT +
    (n - 1) * WIDGET_ROW_GAP +
    WIDGET_TOP_HEADROOM;

  if (state.visible.some((item) => item.type === 'message')) {
    height += WIDGET_MESSAGE_EXPAND_HEADROOM;
  }

  return { width: WIDGET_STACK_WIDTH, height };
}

/**
 * Window size while the wordmark hover list is open.
 * Empty items → idle 66×43. Otherwise width stack width; height from mark +
 * margins + list padding + compact rows + gaps + separators (+ message
 * expand headroom so quick-reply hover-expand never clips).
 */
export function widgetHoverWindowSize(
  items: WidgetStackItem[],
  separators: number,
): { width: number; height: number } {
  if (items.length === 0) {
    return { width: WIDGET_IDLE_WIDTH, height: WIDGET_IDLE_HEIGHT };
  }

  let height =
    WIDGET_MARK_AREA +
    WIDGET_STACK_MARGIN_BOTTOM +
    WIDGET_TOP_HEADROOM +
    WIDGET_HOVER_LIST_PADDING +
    WIDGET_HOVER_HEADER_HEIGHT +
    WIDGET_HOVER_FOOTER_HEIGHT +
    items.length * WIDGET_HOVER_ROW_HEIGHT +
    (items.length > 1 ? (items.length - 1) * WIDGET_HOVER_ROW_GAP : 0) +
    separators * WIDGET_HOVER_SEPARATOR_HEIGHT;

  if (
    items.some(
      (item) => item.type === 'message' && !item.compactGroupCount,
    )
  ) {
    height += WIDGET_MESSAGE_EXPAND_HEADROOM;
  }

  return { width: WIDGET_HOVER_PANEL_WIDTH + 20, height };
}

/**
 * Window size for a click-pinned hover panel with zero recent rows.
 *
 * US-010: clicking the wordmark must always produce visible feedback, even on
 * a fresh session with empty recent history. Hover-only with zero items stays
 * idle-sized (no empty panel flash); only an explicit pin uses this size —
 * one empty-state row at the same hover panel width as a single-item list.
 */
export function widgetEmptyHoverWindowSize(): { width: number; height: number } {
  // Delegate to the real sizing fn with one synthetic non-message row so the
  // empty-state panel can never drift from single-item hover geometry.
  const placeholderRow: WidgetStackItem = {
    id: 'empty-state',
    type: 'system',
    text: '',
    ts: 0,
    kind: 'empty',
    clickActionId: '',
    data: null,
    expiresAt: 0,
  };
  return widgetHoverWindowSize([placeholderRow], 0);
}
