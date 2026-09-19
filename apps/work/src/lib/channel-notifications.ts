import type { ChatWakeEvents } from '@hq/ui';

export type ChannelNotification = Record<string, unknown>;
const KEY = 'channel-notifications-v1';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function readChannelNotifications(storage: StorageLike): ChannelNotification[] {
  try {
    const rows: unknown = JSON.parse(storage.getItem(KEY) || '[]');
    if (!Array.isArray(rows)) return [];
    const restored: ChannelNotification[] = [];
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id.startsWith('local:channel:')) continue;
      // Old native rollups had no event identity, but minted a row per poll.
      if (!row.sourceEventId && !row.actorPersonUid && (!row.actorName || row.actorName === 'Someone') && typeof row.targetRef === 'string' && row.targetRef.startsWith('/channels/')) {
        const id = `local:channel:${row.targetRef.slice('/channels/'.length)}:summary`;
        const previous = restored.find(item => item.id === id);
        if (previous) {
          if (row.status !== 'read') previous.status = 'unread';
          continue;
        }
        restored.push({...row, id, actorName: '', authorName: undefined});
      } else restored.push(row);
    }
    return restored.slice(0, 50);
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
  const identity = wake.eventId?.trim() || 'summary';
  const id = `local:channel:${wake.channelId}:${identity}`;
  if (identity !== 'summary' && rows.some(row => row.id === id)) return rows;
  // The actor is the PERSON who posted; the channel is context. Naming the
  // channel as the actor rendered "#project-x-a61db44b sent a message".
  const author = (authorName || wake.fromDisplayName || wake.fromEmail || '').trim();
  return [{id, type: 'channel_message', status: 'unread', createdAt: wake.createdAt || new Date(now).toISOString(),
    sourceEventId: wake.eventId, actorName: author, authorName: author || undefined,
    actorPersonUid: wake.fromPersonUid || undefined,
    channelName: `#${channelName || wake.channelId}`,
    title: 'Sent a message', targetRef: `/channels/${wake.channelId}`}, ...rows.filter(row => row.id !== id && row.id !== `local:channel:${wake.channelId}:summary`)].slice(0, 50);
}

/** Resolve native unread rollups through the authenticated channel read path. */
export async function hydrateChannelWake(
  wake: ChatWakeEvents['channel:new-message'],
  fetchChannel: () => Promise<unknown>,
): Promise<ChatWakeEvents['channel:new-message']> {
  if (!wake.absoluteUnread || !(Number(wake.unread) > 0)) return wake;
  if (wake.eventId && resolveWakeAuthorName(wake)) return wake;
  try {
    const raw = await fetchChannel();
    if (!raw || typeof raw !== 'object' || !('messages' in raw) || !Array.isArray(raw.messages)) return wake;
    const messages = raw.messages.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && typeof row.eventId === 'string' && row.eventId.trim()));
    const message = wake.eventId
      ? messages.find(row => row.eventId === wake.eventId)
      : messages.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
    if (!message) return wake;
    const text = (key: string) => typeof message[key] === 'string' ? message[key] as string : undefined;
    return {...wake, eventId: text('eventId'), createdAt: text('createdAt') ?? wake.createdAt,
      fromPersonUid: text('fromPersonUid') ?? wake.fromPersonUid,
      fromDisplayName: text('fromDisplayName') ?? wake.fromDisplayName,
      fromEmail: text('fromEmail') ?? wake.fromEmail};
  } catch { return wake; }
}
