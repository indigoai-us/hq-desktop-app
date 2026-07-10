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
}

/** Full stack state owned by Widget.svelte. */
export interface WidgetStackState {
  visible: WidgetStackItem[];
  queued: WidgetStackItem[];
  occluded: boolean;
}

/** Empty non-occluded stack. */
export function emptyWidgetStack(): WidgetStackState {
  return { visible: [], queued: [], occluded: false };
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

/**
 * Enqueue or show a notification. When occluded, push onto `queued` (newest
 * first); otherwise prepend to `visible` and trim to {@link WIDGET_STACK_MAX}.
 */
export function addItem(state: WidgetStackState, item: WidgetStackItem): WidgetStackState {
  if (state.occluded) {
    return {
      ...state,
      visible: state.visible.slice(),
      queued: [item, ...state.queued],
    };
  }
  return {
    ...state,
    queued: state.queued.slice(),
    visible: [item, ...state.visible].slice(0, WIDGET_STACK_MAX),
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
    };
  }

  // Already clear — no flush.
  if (!state.occluded) {
    return {
      ...state,
      occluded: false,
      visible: state.visible.slice(),
      queued: state.queued.slice(),
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
  };
}

/** Drop visible items whose `expiresAt <= now`. Queued is untouched. */
export function expireItems(state: WidgetStackState, now: number): WidgetStackState {
  const visible = state.visible.filter((item) => item.expiresAt > now);
  if (visible.length === state.visible.length) {
    return state;
  }
  return {
    ...state,
    visible,
    queued: state.queued.slice(),
  };
}

/** Remove an item from visible and queued by id. */
export function dismissItem(state: WidgetStackState, id: string): WidgetStackState {
  return {
    ...state,
    visible: state.visible.filter((item) => item.id !== id),
    queued: state.queued.filter((item) => item.id !== id),
  };
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
