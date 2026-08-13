import { describe, expect, it } from 'vitest';
import {
  buildNotificationsView,
  emptyFeedState,
  formatBadgeCount,
  reduceFeedLoaded,
  reduceReadAll,
  type NotificationItem,
} from '../../src/desktop-alt/chat/notifications-model';
import { readRepoFile } from './harness';

/**
 * US-012 — Desktop: Notifications view (bell) — source contracts + PRD e2e.
 *
 * Grep-the-source specs: lock Rust NOTIF feed commands, NotificationsView
 * wiring into DesktopApp / V4TitleBar, model surface, and the PRD invariant
 * that Mark all read zeros the store and hides the bell badge.
 */

function item(id: string): NotificationItem {
  return {
    id,
    serverType: 'dm',
    displayKind: 'dm_received',
    typeIcon: 'dm',
    actorName: 'Ada',
    actorInitials: 'A',
    verbText: 'Ada sent a message',
    contextLine: 'hello',
    status: 'unread',
    createdAt: '2026-08-12T14:00:00.000Z',
    createdAtMs: Date.parse('2026-08-12T14:00:00.000Z'),
    timestampLabel: '2:00 PM',
    actionKind: null,
    actionRef: null,
    actionButtons: [],
    targetRef: null,
    actionUsed: false,
  };
}

describe('desktop notifications view (US-012)', () => {
  const feedRs = readRepoFile('src-tauri/src/commands/notifications_feed.rs');
  const mainRs = readRepoFile('src-tauri/src/main.rs');
  const modRs = readRepoFile('src-tauri/src/commands/mod.rs');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
  const view = readRepoFile('src/desktop-alt/chat/NotificationsView.svelte');
  const model = readRepoFile('src/desktop-alt/chat/notifications-model.ts');
  const route = readRepoFile('src/desktop-alt/route.ts');

  it('Rust fetch/ack/read-all hit NOTIF endpoints and are registered', () => {
    expect(modRs).toContain('pub mod notifications_feed');
    expect(feedRs).toContain('pub async fn fetch_notifications');
    expect(feedRs).toContain('pub async fn ack_notification');
    expect(feedRs).toContain('pub async fn read_all_notifications');
    expect(feedRs).toContain('/v1/notify/notifications');
    expect(feedRs).toContain('/v1/notify/notifications/ack');
    expect(feedRs).toContain('/v1/notify/notifications/read-all');
    expect(feedRs).toContain('unreadOnly');
    // 404 → empty feed (older servers).
    expect(feedRs).toMatch(/NOT_FOUND|EMPTY_404|404/);
    expect(mainRs).toContain('commands::notifications_feed::fetch_notifications');
    expect(mainRs).toContain('commands::notifications_feed::ack_notification');
    expect(mainRs).toContain('commands::notifications_feed::read_all_notifications');
    expect(mainRs).toContain('commands::notifications_feed::run_notification_action');
  });

  it('does not edit legacy notifications.rs / notification_history beyond registration path', () => {
    // Story boundary: new file owns the feed; legacy modules stay for OS perms / history.
    expect(feedRs).toContain('notifications_feed');
    const legacy = readRepoFile('src-tauri/src/commands/notifications.rs');
    expect(legacy).toContain('notification_permission_state');
    expect(legacy).not.toContain('fetch_notifications');
  });

  it('DesktopApp routes the bell to notifications and renders NotificationsView', () => {
    expect(desktopApp).toContain("import NotificationsView from './chat/NotificationsView.svelte'");
    expect(desktopApp).toContain('<NotificationsView');
    expect(desktopApp).toContain("onopenNotifications={openNotifications}");
    expect(desktopApp).toContain("navigate({ kind: 'notifications' })");
    expect(desktopApp).toContain("route.kind === 'notifications'");
    expect(desktopApp).toContain('unreadCount={notificationsUnreadCount}');
    expect(desktopApp).toContain('onback={exitNotifications}');
    expect(desktopApp).toContain('onunreadchange=');
  });

  it('V4TitleBar shows monochrome unread DOT from unreadCount prop (no red pill count)', () => {
    expect(titleBar).toContain('unreadCount');
    expect(titleBar).toContain('data-testid="titlebar-notifications"');
    expect(titleBar).toContain('data-testid="titlebar-notifications-badge"');
    expect(titleBar).toContain('v4-notif-dot');
    expect(titleBar).not.toContain('v4-notif-badge');
    expect(titleBar).not.toContain('99+');
  });

  it('NotificationsView exposes header, filter, mark-all, rows, actions', () => {
    expect(view).toContain('data-testid="notifications-view"');
    expect(view).toContain('data-testid="notifications-title"');
    expect(view).toContain('data-testid="notifications-back"');
    expect(view).toContain('data-testid="notifications-filter"');
    expect(view).toContain('data-testid="notifications-filter-all"');
    expect(view).toContain('data-testid="notifications-filter-unread"');
    expect(view).toContain('data-testid="notifications-mark-all-read"');
    expect(view).toContain('data-testid="notifications-row"');
    expect(view).toContain('data-testid="notifications-unread-dot"');
    expect(view).toContain('data-testid="notifications-action"');
    expect(view).toContain('data-testid="notifications-type-icon"');
    expect(view).toContain("'fetch_notifications'");
    expect(view).toContain("'ack_notification'");
    expect(view).toContain("'read_all_notifications'");
    expect(view).toContain("'run_notification_action'");
  });

  it('pure model owns mapping, grouping, badge, toggle, and reducers', () => {
    expect(model).toContain('export function mapServerType');
    expect(model).toContain('export function parseNotificationsResponse');
    expect(model).toContain('export function groupNotificationsByDay');
    expect(model).toContain('export function filterNotifications');
    expect(model).toContain('export function formatBadgeCount');
    expect(model).toContain('export function reduceAck');
    expect(model).toContain('export function reduceReadAll');
    expect(model).toContain('export function reduceActionUsed');
    expect(model).toContain('export function actionButtonsFor');
    expect(model).toContain('dayLabel');
    expect(model).toContain('mention');
    expect(model).toContain('agent_finished_story');
    expect(model).toContain('agent_review_request');
    expect(model).toContain('file_shared');
    expect(model).toContain('dm_received');
    expect(model).toContain('infra_flag');
    expect(model).toContain('generic');
  });

  it('route resolves notifications as a first-class kind', () => {
    expect(route).toContain("'notifications'");
    expect(route).toMatch(/case 'notifications':\s*return \{ kind: 'notifications' \}/);
  });

  it('PRD e2e: 3 unread → Mark all read → store + badge agree at 0', () => {
    const base = emptyFeedState('all');
    const loaded = reduceFeedLoaded(base, {
      items: [item('1'), item('2'), item('3')],
      unreadCount: 3,
      nextCursor: null,
    });
    expect(loaded.unreadCount).toBe(3);
    expect(formatBadgeCount(loaded.unreadCount)).toBe('3');

    const after = reduceReadAll(loaded);
    expect(after.unreadCount).toBe(0);
    expect(after.items.every((i) => i.status === 'read')).toBe(true);
    expect(formatBadgeCount(after.unreadCount)).toBeNull();

    const viewModel = buildNotificationsView(after);
    expect(viewModel.badgeText).toBeNull();
    expect(viewModel.headerTitle).toBe('Notifications');
    expect(viewModel.headerUnread).toBe('0 unread');
  });
});
