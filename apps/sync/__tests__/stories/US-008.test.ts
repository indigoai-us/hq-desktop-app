// US-008: Merge Messages + Notifications into one simplified 'Inbox' surface.
// Pure-model assertions + readFileSync source contracts lock the IA merge,
// combined page wiring, unified unread state, and legacy-intent aliases.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../src/lib/workspaces';
import {
  fromV4Route,
  getDesktopCompanies,
  getDesktopHotkeyRoute,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import { getV4SidebarModel, V4_NAV_ITEMS } from '../../src/desktop-alt/v4/model';
import { buildNotificationGroups, type Item } from '../../src/lib/notificationGroups';
import { countUnread } from '../../src/lib/notificationFeedData';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

const desktopApp = read('src/desktop-alt/DesktopApp.svelte');
const inboxPage = read('src/desktop-alt/pages/InboxPage.svelte');
const v4Sidebar = read('src/desktop-alt/v4/V4Sidebar.svelte');
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

describe('US-008: exactly one combined Messages/Notifications sidebar destination', () => {
  it("V4_NAV_ITEMS has exactly one 'inbox' row and no Messages/Notifications labels", () => {
    const inboxItems = V4_NAV_ITEMS.filter((item) => item.id === 'inbox');
    expect(inboxItems).toHaveLength(1);
    expect(inboxItems[0]?.label).toBe('Inbox');
    expect(V4_NAV_ITEMS.some((item) => item.label === 'Messages')).toBe(false);
    expect(V4_NAV_ITEMS.some((item) => item.label === 'Notifications')).toBe(false);
  });

  it('getV4SidebarModel lights exactly the inbox row on the inbox route', () => {
    const model = getV4SidebarModel({ kind: 'inbox' }, workspaces);
    expect(model.nav.filter((row) => row.active).map((row) => row.id)).toEqual(['inbox']);
  });

  it('V4Sidebar puts the unified unread badge on the inbox row only', () => {
    expect(v4Sidebar).toContain("row.id === 'inbox' && notifUnread > 0");
    expect(v4Sidebar).not.toContain("row.id === 'notifications'");
  });
});

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

  it('InboxPage mounts NotificationFeed with title + unread count only (no mark-all-read/tabs/sync)', () => {
    expect(inboxPage).toContain('NotificationFeed');
    expect(inboxPage).toContain('<h1 id="desktop-page-title">Inbox</h1>');
    expect(inboxPage).toContain('inbox-unread-count');
    expect(inboxPage).not.toContain('Mark all read');
    expect(inboxPage).not.toContain('mark-read');
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

  it('DesktopApp mounts InboxPage for the inbox route and drops Messages/Notifications pages', () => {
    expect(desktopApp).toContain("route.kind === 'inbox'");
    expect(desktopApp).toContain('<InboxPage />');
    expect(desktopApp).not.toContain('MessagesPage');
    expect(desktopApp).not.toContain('NotificationsPage');
  });
});

describe('US-008: legacy navigation intents resolve to the combined surface', () => {
  it('resolvePendingDesktopRoute aliases messages/notifications/inbox to inbox; settings:notifications stays settings', () => {
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ kind: 'inbox' });
    expect(resolvePendingDesktopRoute('messages')).toEqual({ kind: 'inbox' });
    expect(resolvePendingDesktopRoute('inbox')).toEqual({ kind: 'inbox' });
    expect(resolvePendingDesktopRoute('settings:notifications')).toEqual({
      kind: 'settings',
      tab: 'notifications',
    });
  });

  it('fromV4Route maps inbox + legacy kinds onto inbox', () => {
    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'inbox' });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'inbox' });
    expect(fromV4Route({ kind: 'inbox' })).toEqual({ kind: 'inbox' });
  });

  it('⌘1 is Inbox and no hotkey resolves to messages or notifications', () => {
    const companies = getDesktopCompanies(workspaces);
    expect(
      getDesktopHotkeyRoute({ key: '1', metaKey: true, ctrlKey: false }, companies),
    ).toEqual({ kind: 'inbox' });
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      const routed = getDesktopHotkeyRoute({ key, metaKey: true, ctrlKey: false }, companies);
      expect(routed?.kind).not.toBe('messages');
      expect(routed?.kind).not.toBe('notifications');
    }
  });
});
