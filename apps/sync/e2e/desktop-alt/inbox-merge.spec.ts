import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fromV4Route,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import { readRepoFile } from './harness';

/**
 * US-006 / US-008 / US-018 — Notifications chronology + first-class Messages.
 *
 * US-018 retired InboxPage. Notification chronology is NotificationsView on
 * the `notifications` route; Messages remains its own destination. Legacy
 * `inbox` deep links remap to notifications.
 *
 * Locks:
 *  - Notifications and Messages are distinct live routes.
 *  - `messages` → Messages; `notifications` / `inbox` → Notifications.
 *  - NotificationsView is the dedicated feed (All | Unread, Mark all read).
 *  - Message hover-expand + quick-reply + emoji react still live in NotificationRow
 *    for shared popover/widget paths.
 */

const root = process.cwd();

describe('US-006 / US-008 / US-018: Notifications chronology and Messages route', () => {
  const route = readRepoFile('src/desktop-alt/route.ts');
  const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');

  it('retires InboxPage and keeps Notifications + Messages as live destinations', () => {
    expect(existsSync(join(root, 'src/desktop-alt/pages/InboxPage.svelte'))).toBe(false);

    // DesktopRoute union names the live kinds (not inbox).
    expect(route).toMatch(/'\s*notifications\s*'/);
    expect(route).toMatch(/'\s*messages\s*'/);
    expect(route).toContain('Notifications (notification chronology)');
    expect(route).not.toMatch(/kind:\s*'inbox'/);

    // Shell mounts NotificationsView + MessagesShell.
    expect(app).toContain('NotificationsView');
    expect(app).toContain("route.kind === 'notifications'");
    expect(app).toContain("route.kind === 'messages'");
    expect(app).not.toContain('InboxPage');
  });

  it('messages → Messages; notifications + legacy inbox → Notifications', () => {
    expect(resolvePendingDesktopRoute('messages')).toEqual({ kind: 'messages' });
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ kind: 'notifications' });
    expect(resolvePendingDesktopRoute('inbox')).toEqual({ kind: 'notifications' });

    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'messages' });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'notifications' });
    expect(fromV4Route({ kind: 'inbox' })).toEqual({ kind: 'notifications' });

    expect(route).toContain("case 'messages':");
    expect(route).toContain("case 'notifications':");
    expect(route).toContain("case 'inbox':");
    expect(route).toContain("return { kind: 'messages' }");
    expect(route).toContain("return { kind: 'notifications' }");
  });
});

describe('US-006 / US-008 / US-018: NotificationsView surface', () => {
  const notifications = readRepoFile('src/desktop-alt/chat/NotificationsView.svelte');

  it('renders the unified notifications feed with filter + mark-all-read', () => {
    expect(notifications).toContain('data-testid="notifications-view"');
    expect(notifications).toContain('data-testid="notifications-title"');
    expect(notifications).toContain('data-testid="notifications-filter"');
    expect(notifications).toContain('data-testid="notifications-filter-all"');
    expect(notifications).toContain('data-testid="notifications-filter-unread"');
    expect(notifications).toContain('data-testid="notifications-mark-all-read"');
    expect(notifications).toContain("invoke<unknown>('fetch_notifications'");
    expect(notifications).toContain("invoke('ack_notification'");
    expect(notifications).toContain("invoke('read_all_notifications'");
  });

  it('is a main-pane feed without detached-window / tab chrome', () => {
    expect(notifications).not.toContain("open_messages_window");
    expect(notifications).not.toContain("open_inbox_window");
    expect(notifications).not.toContain('data-testid="desktop-alt-toggle"');
    expect(notifications).not.toContain('Sync Now');
    expect(notifications).not.toContain('overflow-menu');
    expect(notifications).not.toContain('role="tablist"');
  });
});

describe('US-006 / US-008: NotificationRow message hover-expand', () => {
  const row = readRepoFile('src/components/NotificationRow.svelte');
  const feed = readRepoFile('src/components/NotificationFeed.svelte');

  it('message rows hover-expand with quick-reply + emoji react', () => {
    // US-011 added an opt-out gate (`hoverExpand`; the quick-window side pane
    // passes false). The default MUST stay true so popover/widget message rows
    // still hover-expand exactly as locked here. US-012 added `replyHold`
    // (reply focus or draft) as an additional expand keeper.
    expect(row).toContain(
      'const expanded = $derived(\n' +
        '    isMessage && hoverExpand && (hovered || focusWithin || replyHold),\n' +
        '  );',
    );
    expect(row).toContain('hoverExpand = true');
    expect(row).toContain('hoverExpand?: boolean');
    expect(row).toContain('class:nr-expanded={expanded}');
    expect(row).toContain('data-expanded={expanded}');
    // Quick-reply input
    expect(row).toContain('class="nr-reply"');
    expect(row).toContain('placeholder="Reply…"');
    expect(row).toContain('onreply?: (text: string) => void | Promise<void>');
    // Emoji react
    expect(row).toContain("const REACT_EMOJI = ['👍', '❤️', '👀'] as const");
    expect(row).toContain('class="nr-react"');
    expect(row).toContain('onreact?: (emoji: string) => void | Promise<void>');
    expect(row).toContain('onclick={() => void react(emoji)}');
    expect(row).toContain('aria-busy={reactionPending === emoji}');
    expect(row).toContain("replyError = 'Couldn’t send. Your reply is still here.'");
    expect(row).toContain('data-testid="notification-reply-retry"');
  });

  it('NotificationFeed wires reply/react into the shared row', () => {
    expect(feed).toContain('import NotificationRow from \'./NotificationRow.svelte\'');
    expect(feed).toContain('onreply={(text) => replyDm(it, text)}');
    expect(feed).toContain('onreact={(emoji) => reactDm(it, emoji)}');
    expect(feed).toContain('throw e;');
  });

  it('does not nest action buttons inside a focusable role=button row', () => {
    expect(row).not.toContain("role={interactive ? 'button' : undefined}");
    expect(row).not.toContain('tabindex={interactive ? 0 : undefined}');
    expect(row).toContain('role="group"');
    expect(row).toContain('class="nr-primary-action"');
    expect(row).toContain('aria-label={primaryActionLabel}');
    expect(row).toMatch(/\.nr-actions\s*\{[\s\S]*?display:\s*inline-flex;[\s\S]*?opacity:\s*0;/);
    expect(row).toMatch(
      /\.nr:not\(\.nr-message\):focus-within \.nr-actions[\s\S]*?opacity:\s*1;/,
    );
  });
});
