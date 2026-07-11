/**
 * Pure widget notification stack — queue-on-occlusion + visible stack sizing.
 *
 * Framework-free (no Tauri, no Svelte) so unit tests and the Widget component
 * share the same reducers. Rust emits `widget:notification` / `widget:occlusion`;
 * this module only owns in-memory stack semantics and window size math.
 */

/** Auto-collapse timeout for each visible stack row (ms). */
export const WIDGET_ROW_TIMEOUT_MS = 8000;

/** Max visible rows; overflow drops the oldest visible. */
export const WIDGET_STACK_MAX = 4;

/** Idle wordmark window width (logical px) — matches Rust WIDGET_W. */
export const WIDGET_IDLE_WIDTH = 66;

/** Idle wordmark window height (logical px) — matches Rust WIDGET_H. */
export const WIDGET_IDLE_HEIGHT = 43;

/** One-line notification row width (mockup). */
export const WIDGET_ROW_WIDTH = 244;

/**
 * Window width with a visible stack: row (244) + 20px side slack for hover
 * Open/Dismiss actions that sit at the row edge.
 */
export const WIDGET_STACK_WIDTH = 264;

/** Lower mark area height (idle window height). */
export const WIDGET_MARK_AREA = 43;

/** Gap between the stack column and the wordmark (mockup margin-bottom). */
export const WIDGET_STACK_MARGIN_BOTTOM = 12;

/** Collapsed row height (mockup). */
export const WIDGET_ROW_HEIGHT = 30;

/** Vertical gap between stacked rows (mockup). */
export const WIDGET_ROW_GAP = 6;

/** Top padding / superscript headroom above the stack. */
export const WIDGET_TOP_HEADROOM = 10;

/**
 * Extra window height when any visible row is type `message` so the
 * NotificationRow hover-expand (body + reply + reacts) fits without clipping.
 */
export const WIDGET_MESSAGE_EXPAND_HEADROOM = 110;

/** Cap for the recent-notification history list (hover + future surfaces). */
export const WIDGET_RECENT_MAX = 20;

/** Max rows shown in the wordmark hover list. */
export const WIDGET_HOVER_MAX = 8;

/** Compact hover-list row height. */
export const WIDGET_HOVER_ROW_HEIGHT = 28;

/** Day-separator row height in the hover list. */
export const WIDGET_HOVER_SEPARATOR_HEIGHT = 21;

/** Frosted popup panel width. */
export const WIDGET_HOVER_PANEL_WIDTH = 264;

/** Gap between popup rows. */
export const WIDGET_HOVER_ROW_GAP = 1;

/** Vertical padding inside the hover frosted panel. */
export const WIDGET_HOVER_LIST_PADDING = 12;

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
   * Optional chip action id from the banner payload. Preserved for open-routing
   * and future stories — the locked one-line widget row does not render a chip.
   */
  actionId?: string | null;
  /**
   * Optional chip action label from the banner payload. Preserved for open-routing
   * and future stories — the locked one-line widget row does not render a chip.
   */
  actionLabel?: string | null;
  /** Epoch ms — visible items with `expiresAt <= now` are dropped. */
  expiresAt: number;
  /** Unread marker for recent/hover list (set true on addItem). */
  unread?: boolean;
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

  return {
    id,
    type,
    actor,
    text,
    ts: now,
    kind,
    clickActionId: payload.clickActionId,
    data: payload.data,
    actionId: payload.actionId,
    actionLabel: payload.actionLabel,
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
  const recent = prependRecent(state.recent, item);
  if (state.occluded) {
    return {
      ...state,
      visible: state.visible.slice(),
      queued: [item, ...state.queued],
      recent,
    };
  }
  return {
    ...state,
    queued: state.queued.slice(),
    visible: [item, ...state.visible].slice(0, WIDGET_STACK_MAX),
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
 */
export function hoverItems(state: WidgetStackState): WidgetStackItem[] {
  return state.recent.slice(0, WIDGET_HOVER_MAX);
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
 * Backend clamps to 66..340 × 43..480.
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
    items.length * WIDGET_HOVER_ROW_HEIGHT +
    (items.length > 1 ? (items.length - 1) * WIDGET_HOVER_ROW_GAP : 0) +
    separators * WIDGET_HOVER_SEPARATOR_HEIGHT;

  if (items.some((item) => item.type === 'message')) {
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
