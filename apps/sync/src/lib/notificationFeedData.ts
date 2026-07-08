/**
 * Shared notification-feed data layer — used by both the menubar popover feed
 * (`components/NotificationFeed.svelte`) and the desktop Notifications page
 * (`desktop-alt/pages/NotificationsPage.svelte`).
 *
 * Owns:
 *   - loading + merging the server notification history with the current
 *     session's activity log (moved verbatim from NotificationFeed.svelte),
 *   - the local "read" watermark (a persisted last-read timestamp) that drives
 *     unread dots, the tab badge, and Mark-all-read,
 *   - small display helpers (relative timestamps, avatar initials).
 *
 * The read state is machine-local by design: the backend has no read-receipt
 * API, so a monotonic watermark in localStorage is the honest source of truth.
 */

import { invoke } from '@tauri-apps/api/core';
import type { DmEvent, ShareEvent, Item } from './notificationGroups';

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
/** Dedup key so a file present in BOTH the server feed and the current
 *  session's activity log isn't shown twice (server is authoritative). */
function fileKey(company: string, path: string): string {
  return `${company} ${path}`;
}

/**
 * Load + merge the notification timeline (newest-first). Server-retained
 * history (DMs + shares + cross-session new files) plus any of THIS session's
 * new files not yet reflected server-side, deduped by company+path.
 */
export async function loadNotificationItems(): Promise<Item[]> {
  const [history, activity] = await Promise.all([
    invoke<NotificationHistoryResponse>('fetch_notification_history'),
    invoke<ActivityEntry[]>('get_activity_log').catch(() => [] as ActivityEntry[]),
  ]);

  const serverFiles = history.files ?? [];
  const seenFiles = new Set(
    serverFiles.map((f) => fileKey(f.companySlug || f.companyUid || '', f.path)),
  );
  const sessionNewFiles = (activity ?? [])
    .filter((a) => a.isNew === true && a.direction === 'down')
    .filter((a) => !seenFiles.has(fileKey(a.company, a.path)));

  const merged: Item[] = [
    ...(history.dms ?? []).map(dmItem),
    ...(history.shares ?? []).map(shareItem),
    ...serverFiles.map(serverFileItem),
    ...sessionNewFiles.map(newFileItem),
  ];
  merged.sort((a, b) => b.ts - a.ts);
  return merged;
}

// ── Read watermark ────────────────────────────────────────────────────────────

const LAST_READ_KEY = 'hq-sync:notifications-last-read';

export function getLastReadTs(): number {
  try {
    const raw = localStorage.getItem(LAST_READ_KEY);
    const n = raw == null ? 0 : Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Advance the watermark to now (Mark all read). Returns the new watermark.
 *  Broadcasts `hq:notifications-read` so in-window badge consumers (e.g. the
 *  V4 sidebar) recompute without a data refetch. */
export function markAllNotificationsRead(now: number = Date.now()): number {
  try {
    localStorage.setItem(LAST_READ_KEY, String(now));
  } catch {
    // localStorage unavailable — unread dots just persist for the session.
  }
  try {
    window.dispatchEvent(new CustomEvent('hq:notifications-read', { detail: { at: now } }));
  } catch {
    // Non-browser context (unit tests) — nothing to notify.
  }
  return now;
}

/** True when the item is newer than the read watermark. */
export function isUnread(item: Item, lastReadTs: number): boolean {
  return item.ts > lastReadTs;
}

export function countUnread(items: Item[], lastReadTs: number): number {
  return items.reduce((n, it) => n + (isUnread(it, lastReadTs) ? 1 : 0), 0);
}

// ── Display helpers ───────────────────────────────────────────────────────────

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
