import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { fetchServerUnreadIds, serverRowToItemId } from './notificationFeedData';

describe('serverRowToItemId', () => {
  it.each([
    ['dm', 'dm:e1'],
    ['dm_received', 'dm:e1'],
    ['file_share', 'share:e1'],
    ['file_shared', 'share:e1'],
    ['new_file', 'file:e1'],
    ['file_added', 'file:e1'],
    ['DM', 'dm:e1'],
  ])('maps %s to the popover id shape', (type, expected) => {
    expect(serverRowToItemId({ type, sourceEventId: 'e1' })).toBe(expected);
  });

  it('returns null for unknown types or a missing source event', () => {
    expect(serverRowToItemId({ type: 'mention', sourceEventId: 'e1' })).toBeNull();
    expect(serverRowToItemId({ type: 'dm', sourceEventId: '  ' })).toBeNull();
    expect(serverRowToItemId({ type: 'dm' })).toBeNull();
  });
});

describe('fetchServerUnreadIds', () => {
  beforeEach(() => invoke.mockReset());

  it('asks for unread rows and collects ids across pages until the cursor runs out', async () => {
    invoke
      .mockResolvedValueOnce({
        notifications: [{ type: 'dm', status: 'unread', sourceEventId: 'a' }],
        nextCursor: 'c2',
      })
      .mockResolvedValueOnce({
        notifications: [{ type: 'file_share', status: 'unread', sourceEventId: 'b' }],
        nextCursor: null,
      });
    const ids = await fetchServerUnreadIds();
    expect([...ids].sort()).toEqual(['dm:a', 'share:b']);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(1, 'fetch_notifications', {
      limit: 100,
      cursor: null,
      unreadOnly: true,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'fetch_notifications', {
      limit: 100,
      cursor: 'c2',
      unreadOnly: true,
    });
  });

  it('drops rows the server returned as read despite the unread filter', async () => {
    invoke.mockResolvedValueOnce({
      notifications: [
        { type: 'dm', status: 'read', sourceEventId: 'a' },
        { type: 'dm', status: 'unread', sourceEventId: 'b' },
        { type: 'mention', status: 'unread', sourceEventId: 'c' },
      ],
    });
    expect([...(await fetchServerUnreadIds())]).toEqual(['dm:b']);
  });

  it('stops after ten pages even if the server keeps handing back cursors', async () => {
    invoke.mockResolvedValue({
      notifications: [{ type: 'dm', status: 'unread', sourceEventId: 'a' }],
      nextCursor: 'again',
    });
    await fetchServerUnreadIds();
    expect(invoke).toHaveBeenCalledTimes(10);
  });

  it('propagates a backend failure instead of pretending everything is read', async () => {
    invoke.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchServerUnreadIds()).rejects.toThrow('offline');
  });
});
