// US-008: Keep a simplified Inbox notification chronology while restoring the
// complete Messages workspace as a first-class destination.
//
// PL-07 deleted the tray popover's NotificationFeed, so the feed-source
// contracts that used to live here are gone. The unified dm+share model claim
// moved onto the surviving quick-window side pane, which groups both kinds into
// one conversation rail; the desktop Inbox is covered by
// packages/ui/src/inbox/NotificationsView.test.ts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Item } from '../../src/lib/notificationGroups';
import { conversationRows } from '../../src/lib/quickWindowPane';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');
const notificationRow = read('src/components/NotificationRow.svelte');

describe('US-008: dm and share are one unified feed', () => {
  it('conversationRows keeps dm and share rows side by side with unified unread state', () => {
    const now = Date.now();
    const dm: Item = {
      id: 'dm:1',
      kind: 'dm',
      actor: 'Corey',
      summary: 'hey',
      ts: now,
      dm: {
        eventId: 'evt-1',
        fromPersonUid: 'p1',
        fromEmail: 'corey@example.com',
        fromDisplayName: 'Corey',
        body: 'hey',
        createdAt: new Date(now).toISOString(),
      },
    };
    const share: Item = {
      id: 'share:1',
      kind: 'share',
      actor: 'Alex',
      summary: 'shared a file',
      ts: now - 60_000,
      share: {
        eventId: 'evt-2',
        issuerEmail: 'alex@example.com',
        issuerDisplayName: 'Alex',
        paths: ['docs/a.md'],
        note: null,
        permission: 'view',
        createdAt: new Date(now - 60_000).toISOString(),
      },
    };

    const allUnread = new Set(['dm:1', 'share:1']);
    const rows = conversationRows([dm, share], allUnread, new Set());
    expect(rows.map((row) => row.kind)).toEqual(['dm', 'share']);
    expect(rows.reduce((n, row) => n + row.unreadCount, 0)).toBe(2);

    const noneUnread = conversationRows([dm, share], new Set(), new Set());
    expect(noneUnread.reduce((n, row) => n + row.unreadCount, 0)).toBe(0);
  });

  it('NotificationRow message rows hover-expand and the type union covers all kinds including meeting', () => {
    expect(notificationRow).toContain('nr-expanded');
    expect(notificationRow).toContain('nr-reply');
    expect(notificationRow).toContain('nr-react');
    for (const kind of [
      "'message'",
      "'mention'",
      "'share'",
      "'sync'",
      "'deploy'",
      "'meeting'",
      "'system'",
    ]) {
      expect(notificationRow).toContain(kind);
    }
  });
});
