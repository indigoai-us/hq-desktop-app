// Session transcript types + pure derivation helpers.
//
// Lifted from the parked `feature/hq-agent-workspace` design module, carrying
// ONLY the presentation contract the transcript components need — the `Ws*`
// shapes, the deterministic formatters, `buildTimelineItems`, and the
// twelve-class activity taxonomy. Every sample-data export (channels, rosters,
// message lists, home feed) was deliberately left behind: this module is a
// type + function surface, never sample data.
//
// PURE and node-safe: no window/Tauri references and no `Date.now()` in any
// rendered value, so tests can assert invariants directly and screenshots
// never drift between runs. All display formatting is UTC-based for the same
// reason.

export type WsPresence = 'online' | 'away' | 'offline';
export type WsMemberKind = 'human' | 'agent';
export type WsAgentRuntime = 'fleet' | 'local';

export interface WsMember {
  uid: string;
  displayName: string;
  kind: WsMemberKind;
  presence: WsPresence;
  /** Agents only — where the agent runs. */
  runtime?: WsAgentRuntime;
  /** Agents only — provenance: the human who added the agent. */
  addedBy?: string;
  /** Agents only — provenance: the company the agent belongs to. */
  company?: string;
}

export interface WsAttachment {
  attachmentId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface WsReaction {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

export interface WsMessage {
  id: string;
  kind: 'message' | 'system';
  authorUid: string;
  body: string;
  /** Deterministic ISO-8601 UTC timestamp. Never derived from Date.now(). */
  createdAt: string;
  editedAt?: string;
  tombstone?: boolean;
  attachments?: WsAttachment[];
  reactions?: WsReaction[];
  /** Reply count when this message roots a thread. */
  threadCount?: number;
  /**
   * The assistant is still streaming into this row. Presentation-only: the
   * row draws a caret and marks itself aria-busy; nothing else changes.
   */
  streaming?: boolean;
}

/** Screen states every transcript surface must be able to render. */
export const WS_SCREEN_STATES = ['loaded', 'skeleton', 'empty', 'loading'] as const;
export type WsScreenState = (typeof WS_SCREEN_STATES)[number];

// ---------------------------------------------------------------------------
// Deterministic formatting (UTC — no locale, no local timezone, no "now")
// ---------------------------------------------------------------------------

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "9:01 AM" from an ISO timestamp, in UTC for determinism. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  const rawHours = d.getUTCHours();
  const suffix = rawHours >= 12 ? 'PM' : 'AM';
  const hours = rawHours % 12 || 12;
  return `${hours}:${String(d.getUTCMinutes()).padStart(2, '0')} ${suffix}`;
}

/** "Friday, July 24" from an ISO timestamp, in UTC for determinism. */
export function formatDayLabel(iso: string): string {
  const d = new Date(iso);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "47 KB" / "1.2 MB" attachment size label. */
export function formatFileSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** "CE" initials for the achromatic avatar glyph. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '';
  return (first + last).toLocaleUpperCase('en-US');
}

// ---------------------------------------------------------------------------
// Activity taxonomy
// ---------------------------------------------------------------------------

/**
 * The complete activity taxonomy — every agent event lands in exactly one of
 * these twelve presentation classes.
 *
 * Spine (read constantly): message, relay-op, file-edit, shell-command,
 * tool-status (tool status & turn lifecycle).
 * High-value context: thought, plan, permission, error.
 * Ambient safety net: generic-tool, raw-rail, suppressed.
 */
export const WS_ACTIVITY_CLASSES = [
  'message',
  'relay-op',
  'file-edit',
  'shell-command',
  'tool-status',
  'thought',
  'plan',
  'permission',
  'error',
  'generic-tool',
  'raw-rail',
  'suppressed',
] as const;
export type WsActivityClass = (typeof WS_ACTIVITY_CLASSES)[number];

/**
 * Mutate-in-place lifecycle: one action is one row that moves through
 * pending → executing → done/failed. Waiting and timed-out are rendered
 * states too — agents never go dark.
 *
 * Declared as a `const` tuple rather than a bare type union so the six
 * statuses have exactly ONE definition that both the type checker and a
 * runtime test can read.
 */
export const WS_ACTIVITY_STATUSES = [
  'pending',
  'executing',
  'done',
  'failed',
  'waiting-approval',
  'timed-out',
] as const;
export type WsActivityStatus = (typeof WS_ACTIVITY_STATUSES)[number];

export interface WsActivityItem {
  id: string;
  cls: WsActivityClass;
  status: WsActivityStatus;
  agentUid: string;
  /** Verb → object → outcome framing. */
  verb: string;
  object: string;
  outcome?: string;
  /** Secondary/expandable supporting line. */
  detail?: string;
  /** Raw-rail rows: the ground-truth payload behind the expander. */
  raw?: string;
  createdAt: string;
  /** Suppressed rows: how many noise events were deliberately not rendered. */
  suppressedCount?: number;
}

// ---------------------------------------------------------------------------
// Timeline derivation (grouping + dividers), kept pure so tests pin it
// ---------------------------------------------------------------------------

export type WsTimelineItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'unread'; key: string }
  | { type: 'system'; key: string; message: WsMessage }
  /**
   * An agent activity row IN the stream, so delegated work is visible where
   * the reader already is. `SystemMessageRow` is the precedent for a
   * non-message row in the timeline: it breaks grouping, and it is never
   * treated as a message (no reactions, no thread, no edit). `link` rides
   * alongside `item` rather than inside it so the presentation-pure
   * `WsActivityItem` is untouched.
   */
  | { type: 'activity'; key: string; item: WsActivityItem; link?: string }
  | { type: 'message'; key: string; message: WsMessage; grouped: boolean };

const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** An activity row as the timeline consumes it: the item plus its output link. */
export type WsTimelineActivity = WsActivityItem & { link?: string };

/**
 * Derive render items from a message list: day dividers on UTC date changes,
 * one unread divider above `unreadFirstId`, system rows standalone, and
 * consecutive same-author messages within 5 minutes grouped (header
 * collapsed). Tombstones never group with neighbours.
 *
 * The OPTIONAL `activity` stream is interleaved by `createdAt`. ADDITIVE
 * DISCIPLINE: with no activity passed, every loop below is a no-op and the
 * returned timeline is identical to the activity-free output.
 */
export function buildTimelineItems(
  messages: WsMessage[],
  unreadFirstId?: string,
  activity?: ReadonlyArray<WsTimelineActivity>,
): WsTimelineItem[] {
  const items: WsTimelineItem[] = [];
  let prevDay = '';
  let prev: WsMessage | null = null;

  // Oldest-first, stable. Sorted on a copy so a caller's array is never
  // mutated.
  const acts = [...(activity ?? [])].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
  let nextAct = 0;

  /** Emit every activity row at or before `boundary` (all of them when absent). */
  function drainActivity(boundary?: string): void {
    while (nextAct < acts.length) {
      const act = acts[nextAct]!;
      if (boundary !== undefined && act.createdAt > boundary) return;
      nextAct += 1;
      const day = act.createdAt.slice(0, 10);
      if (day !== prevDay) {
        items.push({ type: 'day', key: `day-${day}`, label: formatDayLabel(act.createdAt) });
        prevDay = day;
      }
      items.push({ type: 'activity', key: `activity-${act.id}`, item: act, link: act.link });
      // Breaks grouping exactly like a system row: the next message re-draws
      // its author header rather than reading as a continuation across an
      // agent's work.
      prev = null;
    }
  }

  for (const message of messages) {
    drainActivity(message.createdAt);
    const day = message.createdAt.slice(0, 10);
    if (day !== prevDay) {
      items.push({ type: 'day', key: `day-${day}`, label: formatDayLabel(message.createdAt) });
      prevDay = day;
      prev = null;
    }
    if (unreadFirstId && message.id === unreadFirstId) {
      items.push({ type: 'unread', key: 'unread' });
      prev = null;
    }
    if (message.kind === 'system') {
      items.push({ type: 'system', key: message.id, message });
      prev = null;
      continue;
    }
    const grouped =
      prev !== null &&
      prev.authorUid === message.authorUid &&
      !prev.tombstone &&
      !message.tombstone &&
      Date.parse(message.createdAt) - Date.parse(prev.createdAt) <= GROUP_WINDOW_MS;
    items.push({ type: 'message', key: message.id, message, grouped });
    prev = message;
  }
  drainActivity();
  return items;
}
