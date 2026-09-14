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

export function addChannelNotification(
  rows: ChannelNotification[],
  wake: ChatWakeEvents['channel:new-message'],
  selfUid: string,
  channelName: string,
  now = Date.now(),
): ChannelNotification[] {
  // Timeline hydration and local sends also use this bus. Only the native
  // poller's positive absolute unread rollup represents a notification.
  if (!wake.absoluteUnread || !(Number(wake.unread) > 0) || wake.fromPersonUid === selfUid) return rows;
  const identity = wake.eventId?.trim() || wake.createdAt?.trim() || String(now);
  const id = `local:channel:${wake.channelId}:${identity}`;
  if (rows.some(row => row.id === id)) return rows;
  return [{id, type: 'channel_message', status: 'unread', createdAt: wake.createdAt || new Date(now).toISOString(),
    sourceEventId: wake.eventId, actorName: `#${channelName || wake.channelId}`,
    title: 'Sent a message', targetRef: `/channels/${wake.channelId}`}, ...rows].slice(0, 50);
}
