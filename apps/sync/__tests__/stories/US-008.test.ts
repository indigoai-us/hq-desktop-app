// US-008 / US-018: Notifications chronology (retired InboxPage) plus the
// complete Messages workspace as a first-class destination. Pure-model
// assertions + source contracts lock both surfaces and their intent routing.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../src/lib/workspaces';
import {
  fromV4Route,
  getDesktopCompanies,
  getDesktopHotkeyRoute,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import { buildNotificationGroups, type Item } from '../../src/lib/notificationGroups';
import { countUnread } from '../../src/lib/notificationFeedData';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

const desktopApp = read('src/desktop-alt/DesktopApp.svelte');
const notificationsView = read('src/desktop-alt/chat/NotificationsView.svelte');
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

describe('US-008 / US-018: Notifications + first-class Messages (InboxPage retired)', () => {
  it('retires InboxPage / V4Sidebar nav rows; Notifications is the live feed surface', () => {
    expect(existsSync(root('src/desktop-alt/pages/InboxPage.svelte'))).toBe(false);
    expect(existsSync(root('src/desktop-alt/v4/V4Sidebar.svelte'))).toBe(false);
    expect(desktopApp).toContain("import NotificationsView from './chat/NotificationsView.svelte'");
    expect(desktopApp).toContain("id: 'command-go-notifications'");
    expect(desktopApp).toContain("id: 'command-go-messages'");
    // No separate Notifications-vs-Inbox dual nav; Inbox command is gone.
    expect(desktopApp).not.toContain("id: 'command-go-inbox'");
    expect(desktopApp).not.toMatch(/import\s+InboxPage\b/);
    expect(desktopApp).not.toMatch(/<InboxPage\b/);
  });

  it('DesktopApp mounts NotificationsView on the notifications route only', () => {
    expect(desktopApp).toContain("route.kind === 'notifications'");
    expect(desktopApp).toContain('<NotificationsView');
    expect(desktopApp).not.toContain("route.kind === 'inbox'");
  });
});

describe('US-008: combined notification chronology shows both streams as one-line rows with unified unread state', () => {
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

  it('NotificationsView is a first-class feed with title, filters, and explicit Mark all read', () => {
    expect(notificationsView).toContain('data-testid="notifications-view"');
    expect(notificationsView).toContain('data-testid="notifications-title"');
    expect(notificationsView).toContain('data-testid="notifications-filter"');
    expect(notificationsView).toContain('data-testid="notifications-mark-all-read"');
    expect(notificationsView).toContain("invoke('read_all_notifications')");
    expect(notificationsView).toContain("invoke<unknown>('fetch_notifications'");
    // No detached open-messages / open-quick chrome (InboxPage retired).
    expect(notificationsView).not.toContain('inbox-open-messages');
    expect(notificationsView).not.toContain('inbox-open-quick');
    expect(notificationsView).not.toContain("open_messages_window");
    expect(notificationsView).not.toContain("open_inbox_window");
  });

  it('Mark all read is explicit — no auto watermark commit on leave (review fix, US-018 surface)', () => {
    // NotificationsView writes read state via read_all_notifications when the
    // user clicks Mark all read; it does not advance a localStorage watermark
    // on unmount the way the retired InboxPage did.
    expect(notificationsView).toContain('function handleMarkAllRead');
    expect(notificationsView).toContain("invoke('read_all_notifications')");
    expect(notificationsView).not.toContain('markAllNotificationsRead');
    expect(notificationsView).not.toContain('onDestroy(commitRead)');
    expect(notificationsView).not.toContain("window.addEventListener('pagehide'");
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
    // Shared feed still used by widget/popover chronology.
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

  it('DesktopApp mounts Notifications chronology and the complete embedded Messages shell', () => {
    expect(desktopApp).toContain("route.kind === 'notifications'");
    expect(desktopApp).toContain('<NotificationsView');
    expect(desktopApp).toContain("route.kind === 'messages'");
    expect(desktopApp).toContain('<MessagesShell embedded={true} />');
    expect(desktopApp).not.toContain('MessagesPage');
    expect(desktopApp).not.toContain('NotificationsPage');
    expect(desktopApp).not.toMatch(/import\s+InboxPage\b/);
    expect(desktopApp).not.toMatch(/<InboxPage\b/);
  });
});

describe('US-008 / US-018: navigation intents resolve to their complete surfaces', () => {
  it('routes messages to Messages; inbox/notifications deep links land on Notifications', () => {
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ kind: 'notifications' });
    expect(resolvePendingDesktopRoute('messages')).toEqual({ kind: 'messages' });
    // US-018: InboxPage retired — inbox deep link remaps to notifications.
    expect(resolvePendingDesktopRoute('inbox')).toEqual({ kind: 'notifications' });
    expect(resolvePendingDesktopRoute('settings:notifications')).toEqual({
      kind: 'settings',
      tab: 'notifications',
    });
  });

  it('fromV4Route preserves Messages and remaps legacy Inbox onto Notifications', () => {
    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'messages' });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'notifications' });
    expect(fromV4Route({ kind: 'inbox' })).toEqual({ kind: 'notifications' });
  });

  it('⌘1 is Notifications and no hotkey resolves to the retired inbox kind', () => {
    const companies = getDesktopCompanies(workspaces);
    expect(
      getDesktopHotkeyRoute({ key: '1', metaKey: true, ctrlKey: false }, companies),
    ).toEqual({ kind: 'notifications' });
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      const routed = getDesktopHotkeyRoute({ key, metaKey: true, ctrlKey: false }, companies);
      expect(routed?.kind).not.toBe('inbox' as never);
      expect(routed?.kind).not.toBe('messages');
    }
  });
});
