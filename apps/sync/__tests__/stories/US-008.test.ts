// US-008: Keep a simplified Inbox notification chronology while restoring the
// complete Messages workspace as a first-class destination. Pure-model
// assertions + source contracts lock both surfaces and their intent routing.

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
const messagesShell = read('src/components/messaging/MessagesShell.svelte');

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

describe('US-008: Inbox chronology plus first-class Messages', () => {
  it("V4_NAV_ITEMS has one Inbox row, one Messages row, and no Notifications row", () => {
    const inboxItems = V4_NAV_ITEMS.filter((item) => item.id === 'inbox');
    const messagesItems = V4_NAV_ITEMS.filter((item) => item.id === 'messages');
    expect(inboxItems).toHaveLength(1);
    expect(inboxItems[0]?.label).toBe('Inbox');
    expect(messagesItems).toEqual([{ id: 'messages', label: 'Messages' }]);
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

  it('InboxPage mounts NotificationFeed with title + unread subtitle (no detached buttons/tabs/sync)', () => {
    expect(inboxPage).toContain('NotificationFeed');
    expect(inboxPage).toContain('<h1 id="desktop-page-title">Inbox</h1>');
    expect(inboxPage).toContain('inbox-unread-count');
    expect(inboxPage).not.toContain('inbox-open-messages');
    expect(inboxPage).not.toContain('inbox-open-quick');
    expect(inboxPage).not.toContain("open_messages_window");
    expect(inboxPage).not.toContain("open_inbox_window");
    expect(inboxPage).toContain('density="comfortable"');
    expect(inboxPage).not.toContain('Mark all read');
    expect(inboxPage).not.toContain('mark-read');
    expect(inboxPage).not.toContain('role="tablist"');
  });

  it('viewing the Inbox counts as reading it — the watermark advances on leave (review fix)', () => {
    // The header carries no controls (AC), so without this the desktop window
    // would have NO way to ever clear the unified unread badge — the popover's
    // Mark-all-read was the only remaining watermark writer. InboxPage commits
    // the read on unmount + window pagehide, gated on the feed having loaded.
    expect(inboxPage).toContain('markAllNotificationsRead');
    expect(inboxPage).toContain('onDestroy(commitRead)');
    expect(inboxPage).toContain("window.addEventListener('pagehide', commitRead)");
    expect(inboxPage).toContain('if (!feedLoaded) return');
    expect(inboxPage).toContain('onloadstatechange={(loaded) => (feedLoaded = loaded)}');
    expect(inboxPage).not.toContain('feedLoaded = true');
  });

  it('message-person targets preserve warm/cold handoff for the routed Messages shell', () => {
    // DesktopApp owns routing while MessagesShell owns target consumption.
    // Keep both Windows/Tauri delivery paths so a warm event and a cold-start
    // pending target reach the same first-class Messages workspace.
    expect(desktopApp).not.toContain('takePendingConversation()');
    expect(desktopApp).toContain("navigate({ kind: 'messages' })");
    expect(desktopApp).toContain("messages:open-conversation");
    expect(desktopApp).toContain('take_pending_messages_target');
    expect(desktopApp).toContain('requestConversation');
    expect(messagesShell).toContain('takePendingConversation()');
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

  it('DesktopApp mounts Inbox chronology and the complete embedded Messages shell', () => {
    expect(desktopApp).toContain("route.kind === 'inbox'");
    expect(desktopApp).toContain('<InboxPage');
    expect(desktopApp).toContain("route.kind === 'messages'");
    expect(desktopApp).toContain('<MessagesShell embedded={true} />');
    expect(desktopApp).not.toContain('MessagesPage');
    expect(desktopApp).not.toContain('NotificationsPage');
  });
});

describe('US-008: navigation intents resolve to their complete surfaces', () => {
  it('routes messages to Messages, notifications to Notifications, inbox to Inbox', () => {
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ kind: 'notifications' });
    expect(resolvePendingDesktopRoute('messages')).toEqual({ kind: 'messages' });
    expect(resolvePendingDesktopRoute('inbox')).toEqual({ kind: 'inbox' });
    expect(resolvePendingDesktopRoute('settings:notifications')).toEqual({
      kind: 'settings',
      tab: 'notifications',
    });
  });

  it('fromV4Route preserves Messages, Notifications, and Inbox as first-class kinds', () => {
    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'messages' });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'notifications' });
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
