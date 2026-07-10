import { describe, it, expect } from 'vitest';
import { paneItems, rowUnread, defaultSelectedId } from './quickWindowPane';
import type { Item } from './notificationGroups';

function item(
  id: string,
  kind: Item['kind'],
  ts: number,
  extra: Partial<Item> = {},
): Item {
  return { id, kind, actor: 'A', summary: 's', ts, ...extra };
}

describe('paneItems', () => {
  it('keeps only dm and share kinds, preserving order', () => {
    const items: Item[] = [
      item('dm:1', 'dm', 300),
      item('file:1', 'new-file', 200),
      item('share:1', 'share', 100),
      item('dm:2', 'dm', 50),
    ];
    expect(paneItems(items).map((i) => i.id)).toEqual(['dm:1', 'share:1', 'dm:2']);
  });

  it('caps at 30 items', () => {
    const items: Item[] = Array.from({ length: 40 }, (_, i) =>
      item(`dm:${i}`, 'dm', 1000 - i),
    );
    const out = paneItems(items);
    expect(out).toHaveLength(30);
    expect(out[0].id).toBe('dm:0');
    expect(out[29].id).toBe('dm:29');
  });

  it('returns empty when only new-file rows are present', () => {
    expect(paneItems([item('f:1', 'new-file', 1)])).toEqual([]);
  });
});

describe('rowUnread', () => {
  it('is true when newer than watermark and not viewed', () => {
    const it = item('dm:1', 'dm', 100);
    expect(rowUnread(it, 50, new Set())).toBe(true);
  });

  it('viewed overrides unread even when newer than watermark', () => {
    const it = item('dm:1', 'dm', 100);
    expect(rowUnread(it, 50, new Set(['dm:1']))).toBe(false);
  });

  it('watermark boundary: ts equal to lastRead is read', () => {
    const it = item('dm:1', 'dm', 100);
    expect(rowUnread(it, 100, new Set())).toBe(false);
  });

  it('watermark boundary: ts just above lastRead is unread', () => {
    const it = item('dm:1', 'dm', 101);
    expect(rowUnread(it, 100, new Set())).toBe(true);
  });
});

describe('defaultSelectedId', () => {
  it('builds share: and dm: ids', () => {
    expect(defaultSelectedId('share', 'abc')).toBe('share:abc');
    expect(defaultSelectedId('dm', 'xyz')).toBe('dm:xyz');
  });

  it('returns null when eventId is missing', () => {
    expect(defaultSelectedId('share', undefined)).toBeNull();
    expect(defaultSelectedId('dm', undefined)).toBeNull();
    expect(defaultSelectedId('share', '')).toBeNull();
  });
});
