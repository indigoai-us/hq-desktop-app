import type { ChatWakeEvents } from '@hq/ui';

export type ChannelNotification = Record<string, unknown>;
const KEY = 'channel-notifications-v1';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readChannelNotifications(storage: StorageLike): ChannelNotification[] {
  try {
    const rows: unknown = JSON.parse(storage.getItem(KEY) || '[]');
    return Array.isArray(rows) ? rows.filter(row => row && typeof row.id === 'string' && row.id.startsWith('local:channel:')).slice(0, 50) : [];
  } catch { return []; }
}

export function saveChannelNotifications(storage: StorageLike, rows: ChannelNotification[]): void {
  try { storage.setItem(KEY, JSON.stringify(rows.slice(0, 50))); }
  catch { /* Memory feed remains available when local storage is full. */ }
}

/** Person-ish rows a host can search for a display name (contacts, channel members). */
export interface AuthorCandidate {
  personUid?: string | null;
  displayName?: string | null;
  email?: string | null;
}

/**
 * Best client-side name for a wake's author. The mesh payload wins when the
 * server sent a name; otherwise the uid is matched against whoever the client
 * already knows (channel members, then contacts).
 */
export function resolveWakeAuthorName(
  wake: Pick<ChatWakeEvents['channel:new-message'], 'fromPersonUid' | 'fromDisplayName' | 'fromEmail'>,
  candidates: readonly AuthorCandidate[] = [],
): string {
  const sent = (wake.fromDisplayName || wake.fromEmail || '').trim();
  if (sent) return sent;
  const uid = (wake.fromPersonUid || '').trim();
  if (!uid) return '';
  const hit = candidates.find(row => (row?.personUid || '').trim() === uid);
  return (hit?.displayName || hit?.email || '').trim();
}

export function addChannelNotification(
  rows: ChannelNotification[],
  wake: ChatWakeEvents['channel:new-message'],
  selfUid: string,
  channelName: string,
  now = Date.now(),
  /** Display name of whoever sent the message, when the host could resolve it. */
  authorName = '',
): ChannelNotification[] {
  // Timeline hydration and local sends also use this bus. Only the native
  // poller's positive absolute unread rollup represents a notification.
  if (!wake.absoluteUnread || !(Number(wake.unread) > 0) || wake.fromPersonUid === selfUid) return rows;
  const identity = wake.eventId?.trim() || wake.createdAt?.trim() || String(now);
  const id = `local:channel:${wake.channelId}:${identity}`;
  if (rows.some(row => row.id === id)) return rows;
  // The actor is the PERSON who posted; the channel is context. Naming the
  // channel as the actor rendered "#project-x-a61db44b sent a message".
  const author = (authorName || wake.fromDisplayName || wake.fromEmail || '').trim();
  return [{id, type: 'channel_message', status: 'unread', createdAt: wake.createdAt || new Date(now).toISOString(),
    sourceEventId: wake.eventId, actorName: author || 'Someone', authorName: author || undefined,
    actorPersonUid: wake.fromPersonUid || undefined,
    channelName: `#${channelName || wake.channelId}`,
    title: 'Sent a message', targetRef: `/channels/${wake.channelId}`}, ...rows].slice(0, 50);
}
