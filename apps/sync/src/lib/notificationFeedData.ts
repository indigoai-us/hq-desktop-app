/**
 * Shared notification-feed data layer. Its original consumers — the tray
 * popover's feed and the desktop-alt Inbox page — are both gone; what reads it
 * now is the share-detail quick window (`components/QuickWindowSidePane.svelte`
 * and `components/NotificationRow.svelte`).
 *
 * Owns:
 *   - loading + merging the server notification history with the current
 *     session's activity log,
 *   - the server unread set (`fetchServerUnreadIds`) that drives unread dots,
 *   - small display helpers (relative timestamps, avatar initials).
 *
 * The local read watermark this module used to own was deleted in PL-07: the
 * popover's "Mark all read" was its only writer, so with the popover gone it
 * could never advance and every dot would have frozen. Read state is the
 * server's.
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  DmEvent,
  ShareEvent,
  Item,
  UpdateInfo,
} from './notificationGroups';

/** Same-webview signal that keeps Inbox chrome aligned with the loaded feed. */
export const NOTIFICATION_UNREAD_COUNT_EVENT =
  'hq:notifications-unread-count';

export function broadcastNotificationUnreadCount(count: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<number>(NOTIFICATION_UNREAD_COUNT_EVENT, {
      detail: Math.max(0, Math.round(count)),
    }),
  );
}

// ── Wire types (mirror the Rust structs, camelCase) ──────────────────────────
export interface ActivityEntry {
  company: string;
  path: string;
  bytes: number;
  direction: string;
  author?: string;
  isNew?: boolean;
  at: number;
}
export interface FileHistoryItem {
  eventId: string;
  path: string;
  bytes?: number;
  addedBy?: string;
  companyUid?: string;
  companySlug?: string;
  createdAt: string;
}
export interface NotificationHistoryResponse {
  dms: DmEvent[];
  shares: ShareEvent[];
  files: FileHistoryItem[];
}

export interface NotificationLoadOptions {
  /** Popover owns a separate pinned update row; other feed consumers include it. */
  includeUpdates?: boolean;
}

export type PendingUpdateState =
  | { status: 'unchecked' }
  | { status: 'absent' }
  | { status: 'pending'; update: UpdateInfo };

export type UpdateLoadState =
  | 'resolved'
  | 'unchecked'
  | 'failed'
  | 'not-requested';
export type HistoryLoadState = 'resolved' | 'failed';
export type ActivityLoadState = 'resolved' | 'failed';

export interface NotificationLoadResult {
  items: Item[];
  /**
   * `resolved` means native state authoritatively returned an update or null.
   * Widget persistence uses this distinction so an IPC failure never purges a
   * safe display-only row.
   */
  updateState: UpdateLoadState;
  /** Cloud notification history may fail while trusted local update state succeeds. */
  historyState: HistoryLoadState;
  /** Local activity may fail independently of cloud history and updater state. */
  activityState: ActivityLoadState;
}

/**
 * Decode native updater hydration. The legacy UpdateInfo/null branches keep
 * browser fixtures and older sidecars compatible; current native builds return
 * the explicit tri-state so cold-start "unchecked" is never mistaken for a
 * trusted absence.
 */
export function resolvePendingUpdateState(
  value: PendingUpdateState | UpdateInfo | null,
): { state: UpdateLoadState; value: UpdateInfo | null } {
  if (value == null) return { state: 'resolved', value: null };
  if ('status' in value) {
    if (value.status === 'pending') {
      return { state: 'resolved', value: value.update };
    }
    if (value.status === 'absent') {
      return { state: 'resolved', value: null };
    }
    return { state: 'unchecked', value: null };
  }
  return { state: 'resolved', value };
}

function parseTs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function dmItem(e: DmEvent): Item {
  return {
    id: `dm:${e.eventId}`,
    kind: 'dm',
    actor: e.fromDisplayName?.trim() || e.fromEmail || 'Someone',
    summary: e.body,
    ts: parseTs(e.createdAt),
    dm: e,
  };
}
function shareItem(e: ShareEvent): Item {
  const n = e.paths.length;
  const files = e.paths.join(', ');
  const base = n === 1 ? `Shared a file: ${files}` : `Shared ${n} files: ${files}`;
  const summary = e.note && e.note.trim() ? `${base} — “${e.note.trim()}”` : base;
  return {
    id: `share:${e.eventId}`,
    kind: 'share',
    actor: e.issuerDisplayName?.trim() || e.issuerEmail || 'Someone',
    summary,
    ts: parseTs(e.createdAt),
    share: e,
  };
}
function newFileItem(e: ActivityEntry): Item {
  return {
    id: `newfile:${e.company}/${e.path}:${e.at}`,
    kind: 'new-file',
    actor: e.author?.trim() || e.company,
    summary: `New file in ${e.company}: ${e.path}`,
    ts: e.at,
    file: { company: e.company, path: e.path },
  };
}
/** Cross-session new-file row from the server file-history feed. */
function serverFileItem(f: FileHistoryItem): Item {
  // Display label: the human slug only — never the raw cmp_… UID (the
  // companyUid is still used for the dedup key below).
  const co = f.companySlug || '';
  return {
    id: `filehist:${f.eventId}`,
    kind: 'new-file',
    actor: f.addedBy?.trim() || co || 'Sync',
    summary: co ? `New file in ${co}: ${f.path}` : `New file: ${f.path}`,
    ts: parseTs(f.createdAt),
    file: { company: co, path: f.path },
  };
}

// Compatibility fallback for an older/native test payload without detectedAt.
// The first-seen value is stable for the process, unlike Date.now() per reload.
const updateFirstSeen = new Map<string, number>();

function updateItem(update: UpdateInfo): Item {
  let ts = update.detectedAt ? parseTs(update.detectedAt) : 0;
  if (!ts) {
    ts = updateFirstSeen.get(update.version) ?? Date.now();
    updateFirstSeen.set(update.version, ts);
  }
  return {
    id: `update:${update.version}`,
    kind: 'update',
    actor: 'HQ',
    summary: `Version ${update.version} is ready to install.`,
    ts,
    update,
  };
}
/** Dedup key so a file present in BOTH the server feed and the current
 *  session's activity log isn't shown twice (server is authoritative). */
function fileKey(company: string, path: string): string {
  return `${company} ${path}`;
}

/** Server max per-source page size (matches Rust `MAX_LIMIT`). */
export const NOTIFICATION_HISTORY_LIMIT = 200;

/**
 * Load + merge the notification timeline (newest-first). Server-retained
 * history (DMs + shares + cross-session new files) plus any of THIS session's
 * new files not yet reflected server-side, deduped by company+path.
 *
 * Requests the full retained page (200/source) so Inbox and the menubar feed
 * show previous notifications rather than a short default slice.
 */
export async function loadNotificationTimeline(
  limit: number = NOTIFICATION_HISTORY_LIMIT,
  options: NotificationLoadOptions = {},
): Promise<NotificationLoadResult> {
  const includeUpdates = options.includeUpdates !== false;
  const updateRequest: Promise<{
    state: UpdateLoadState;
    value: UpdateInfo | null;
  }> = includeUpdates
    ? invoke<PendingUpdateState | UpdateInfo | null>('get_pending_update')
        .then(resolvePendingUpdateState)
        .catch(() => ({ state: 'failed' as const, value: null }))
    : Promise.resolve({ state: 'not-requested' as const, value: null });
  const historyRequest = invoke<NotificationHistoryResponse>(
    'fetch_notification_history',
    { limit },
  )
    .then((value) => ({
      state: 'resolved' as const,
      value,
    }))
    .catch(() => ({
      state: 'failed' as const,
      value: { dms: [], shares: [], files: [] } satisfies NotificationHistoryResponse,
    }));
  const activityRequest = invoke<ActivityEntry[]>('get_activity_log')
    .then((value) => ({
      state: 'resolved' as const,
      value,
    }))
    .catch(() => ({
      state: 'failed' as const,
      value: [] as ActivityEntry[],
    }));

  const [historyResult, activityResult, pendingUpdate] = await Promise.all([
    historyRequest,
    activityRequest,
    updateRequest,
  ]);
  const history = historyResult.value;

  const serverFiles = history.files ?? [];
  const seenFiles = new Set(
    serverFiles.map((f) => fileKey(f.companySlug || f.companyUid || '', f.path)),
  );
  const sessionNewFiles = (activityResult.value ?? [])
    .filter((a) => a.isNew === true && a.direction === 'down')
    .filter((a) => !seenFiles.has(fileKey(a.company, a.path)));

  const merged: Item[] = [
    ...(history.dms ?? []).map(dmItem),
    ...(history.shares ?? []).map(shareItem),
    ...serverFiles.map(serverFileItem),
    ...sessionNewFiles.map(newFileItem),
    ...(pendingUpdate.value ? [updateItem(pendingUpdate.value)] : []),
  ];
  merged.sort((a, b) => b.ts - a.ts);
  return {
    items: merged,
    updateState: pendingUpdate.state,
    historyState: historyResult.state,
    activityState: activityResult.state,
  };
}

export async function loadNotificationItems(
  limit: number = NOTIFICATION_HISTORY_LIMIT,
  options: NotificationLoadOptions = {},
): Promise<Item[]> {
  return (await loadNotificationTimeline(limit, options)).items;
}

// ── Server read state ────────────────────────────────────────────────────────

/**
 * Map one NOTIF-store row onto the `Item.id` shape this module mints
 * (`dm:${eventId}`, `share:${eventId}`, `file:${eventId}`), or null when the
 * row cannot be matched.
 *
 * Keyed by `sourceEventId`, not the store row `id`: the store row is a
 * notification ABOUT an event, and this module mints ids from the event
 * itself, so `sourceEventId` is the only field the two sides share. That is
 * also the key the desktop composer dedupes on
 * (packages/ui/src/inbox/live-notifications.ts, `composeLiveNotifications`),
 * and the type→prefix map here mirrors its `liveSourceKind`. A row with no
 * `sourceEventId` is skipped rather than keyed on the store id, because that
 * could never match anything and would only look like coverage.
 */
export function serverRowToItemId(row: {
  type?: unknown;
  sourceEventId?: unknown;
}): string | null {
  const source = typeof row.sourceEventId === 'string' ? row.sourceEventId.trim() : '';
  if (!source) return null;
  const t = (typeof row.type === 'string' ? row.type : '').trim().toLowerCase();
  if (t === 'dm' || t === 'dm_received') return `dm:${source}`;
  if (t === 'file_share' || t === 'file_shared') return `share:${source}`;
  if (t === 'new_file' || t === 'file_added') return `file:${source}`;
  return null;
}

/** One page cap; unread is small in practice but a reader with 99+ exists. */
const UNREAD_PAGE_LIMIT = 100;
/** Hard stop on the cursor walk so a misbehaving cursor cannot spin forever. */
const UNREAD_MAX_PAGES = 10;

/**
 * Ids the SERVER says are unread, in `Item.id` shape.
 *
 * This replaces the local `hq-sync:notifications-last-read` watermark for the
 * widget. The watermark had exactly one writer — the popover feed's Mark all
 * read — so retiring the popover would have frozen it, and every dot in the
 * widget with it. The store is what the desktop feed already reads, so this is
 * the same read model rather than a second one that can disagree.
 *
 * Walks `nextCursor` so the tail of a large unread set does not render as
 * read. Rejects on transport failure; the caller decides what "the server said
 * nothing" means for its surface, and it must NOT be "fall back to the
 * watermark" — that is the two-models bug this exists to remove.
 */
interface UnreadPage {
  notifications?: Array<{ type?: unknown; status?: unknown; sourceEventId?: unknown }>;
  nextCursor?: unknown;
}

export async function fetchServerUnreadIds(): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < UNREAD_MAX_PAGES; page++) {
    const res: UnreadPage | null = await invoke<UnreadPage | null>('fetch_notifications', {
      limit: UNREAD_PAGE_LIMIT,
      cursor,
      unreadOnly: true,
    });
    for (const row of res?.notifications ?? []) {
      // `unreadOnly` is a server filter; re-check so a lenient server cannot
      // light a dot for a read row.
      if (row.status !== 'unread') continue;
      const id = serverRowToItemId(row);
      if (id) ids.add(id);
    }
    const next: string = typeof res?.nextCursor === 'string' ? res.nextCursor.trim() : '';
    if (!next) break;
    cursor = next;
  }
  return ids;
}

/** Compact relative timestamp for feed rows: "now", "2m", "3h", "5d", else "Jun 10". */
export function relativeTime(ms: number, now: number = Date.now()): string {
  if (!ms) return '';
  const secs = Math.max(0, Math.round((now - ms) / 1000));
  if (secs < 60) return 'now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  try {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
      new Date(ms),
    );
  } catch {
    return '';
  }
}

/** Up-to-two-letter initials for the 24px avatar chip ("Maya Chen" → "MC"). */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._@-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
