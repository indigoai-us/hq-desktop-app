// US-008: Keep a simplified Inbox notification chronology while restoring the
// complete Messages workspace as a first-class destination. Pure-model
// assertions + source contracts lock both surfaces and their intent routing.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../src/lib/workspaces';
import { buildNotificationGroups, type Item } from '../../src/lib/notificationGroups';
import { countUnread } from '../../src/lib/notificationFeedData';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');
const notificationFeed = read('src/components/NotificationFeed.svelte');
const notificationRow = read('src/components/NotificationRow.svelte');

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    slug: 'indigo',
    displayName: 'Indigo',
    kind: 'company',
    state: 'synced',
    cloudUid: 'cmp_1',
    bucketName: 'bucket',
    hasLocalFolder: true,
    localPath: '/tmp/HQ/companies/indigo',
    membershipStatus: 'active',
    role: 'member',
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

const workspaces: Workspace[] = [
  workspace({ slug: 'indigo', displayName: 'Indigo' }),
  workspace({ slug: 'acme', displayName: 'Acme', state: 'synced' }),
];

describe('US-008: combined Inbox page shows both streams as one-line rows with unified unread state', () => {
  it('buildNotificationGroups + countUnread treat dm and share as one unified feed', () => {
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

    const groups = buildNotificationGroups([dm, share], now);
    expect(groups).toHaveLength(1);
    const singles = groups[0].rows.filter((row) => row.type === 'single');
    expect(singles).toHaveLength(2);

    expect(countUnread([dm, share], 0)).toBe(2);
    expect(countUnread([dm, share], now + 1)).toBe(0);
  });

  it('NotificationFeed wires message rows with reply/react and share rows as share type', () => {
    expect(notificationFeed).toContain('type="message"');
    expect(notificationFeed).toContain('onreply=');
    expect(notificationFeed).toContain('onreact=');
    expect(notificationFeed).toContain('type="share"');
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
