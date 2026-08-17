import { describe, expect, it } from 'vitest';
import {
  fromV4Route,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import { V4_NAV_ITEMS } from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

/**
 * US-006 — US-008 Inbox chronology + first-class Messages (source contracts
 * + route resolution).
 *
 * Locks the restored split:
 *  - Inbox and Messages are distinct primary destinations.
 *  - `messages` resolves to Messages; `notifications` resolves to Inbox.
 *  - InboxPage hosts shared NotificationFeed / one-line NotificationRow with
 *    a title + unread-only header (no tabs / sync / overflow / chrome).
 *  - Message hover-expand + quick-reply + emoji react live in NotificationRow.
 */

describe('US-006 / US-008: Inbox chronology and Messages route', () => {
  const route = readRepoFile('src/desktop-alt/route.ts');

  it('has one Inbox chronology row and one full Messages row', () => {
    const inboxRows = V4_NAV_ITEMS.filter((item) => item.id === 'inbox');
    const messagesRows = V4_NAV_ITEMS.filter((item) => item.id === 'messages');
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]).toEqual({ id: 'inbox', label: 'Inbox' });
    expect(messagesRows).toEqual([{ id: 'messages', label: 'Messages' }]);
    // Notifications are chronology content, not a third destination.
    expect(V4_NAV_ITEMS.map((i) => i.id)).not.toContain('notifications');

    // Both destinations are named in the DesktopRoute union.
    expect(route).toContain("'inbox'");
    expect(route).toContain("'messages'");
    expect(route).toContain('Inbox is');
    expect(route).toContain('notification chronology; Messages is the full conversation workspace');
  });

  it('messages → Messages while notifications → Inbox at both resolution sites', () => {
    // resolvePendingDesktopRoute switch
    expect(resolvePendingDesktopRoute('messages')).toEqual({ kind: 'messages' });
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ kind: 'inbox' });
    expect(resolvePendingDesktopRoute('inbox')).toEqual({ kind: 'inbox' });

    // fromV4Route switch
    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'messages' });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'inbox' });
    expect(fromV4Route({ kind: 'inbox' })).toEqual({ kind: 'inbox' });

    // Both switch sites keep the legacy case arms.
    expect(route).toContain("case 'messages':");
    expect(route).toContain("case 'notifications':");
    expect(route).toContain("return { kind: 'messages' }");
  });
});

describe('US-006 / US-008: InboxPage surface', () => {
  const inbox = readRepoFile('src/desktop-alt/pages/InboxPage.svelte');
  const feed = readRepoFile('src/components/NotificationFeed.svelte');

  it('renders shared NotificationFeed / NotificationRow one-line rows', () => {
    expect(inbox).toContain("import NotificationFeed from '../../components/NotificationFeed.svelte'");
    expect(inbox).toContain('showDayLabels={false}');
    expect(inbox).toContain('onunreadchange={handleUnreadChange}');
    expect(inbox).toContain('onitemschange={handleItemsChange}');
    expect(inbox).toContain('density="comfortable"');
    expect(inbox).toContain('shared one-line NotificationRow');
  });

  it('unified unread header, no detached-window buttons (no tabs / sync chrome)', () => {
    expect(inbox).toContain('data-testid="inbox-unread-count"');
    expect(inbox).toContain('All caught up');
    expect(inbox).toContain('<h1 id="desktop-page-title">Inbox</h1>');
    expect(inbox).not.toContain('data-testid="inbox-open-messages"');
    expect(inbox).not.toContain('data-testid="inbox-open-quick"');
    expect(inbox).not.toContain("open_messages_window");
    expect(inbox).not.toContain("open_inbox_window");
    expect(inbox).toContain('No tabs, no sync button, no overflow menus (US-008).');
    expect(inbox).not.toContain('data-testid="desktop-alt-toggle"');
    expect(inbox).not.toContain('Sync Now');
    expect(inbox).not.toContain('overflow-menu');
    expect(inbox).not.toContain('hq-icon');
    expect(inbox).not.toContain('tab-selector');
    expect(inbox).not.toContain('role="tablist"');
  });

  it('uses row timestamps without a sticky day-label slab', () => {
    expect(inbox).toContain('showDayLabels={false}');
    expect(inbox).toContain(':global(.nr-ts)');
    expect(inbox).not.toContain(':global(.notif-day-label)');
  });

  it('matches the Messages type hierarchy instead of inflating feed text', () => {
    expect(inbox).toContain('font-size: 16px');
    expect(inbox).toContain(
      'font-size: var(--type-metadata, var(--text-micro, 10px))',
    );
    expect(inbox).toContain("Match Messages' compact two-line hierarchy");
    expect(inbox).not.toContain('font-size: var(--type-body, 15px)');
    expect(inbox).not.toContain('font-size: var(--type-metadata, 13px)');
    expect(inbox).not.toContain('inbox-kicker');
  });

  it('uses compact identity marks for comfortable Inbox rows', () => {
    expect(feed).toContain("initials,");
    expect(feed).toContain("identityLabel={density === 'comfortable'");
    expect(feed).toContain('? initials(it.actor)');
    expect(feed).toContain('? initials(row.company)');
  });
});

describe('US-006 / US-008: NotificationRow message hover-expand', () => {
  const row = readRepoFile('src/components/NotificationRow.svelte');
  const feed = readRepoFile('src/components/NotificationFeed.svelte');

  it('message rows hover-expand with quick-reply + emoji react', () => {
    // US-011 added an opt-out gate (`hoverExpand`; the quick-window side pane
    // passes false). The default MUST stay true so popover/widget/Inbox
    // message rows still hover-expand exactly as locked here. US-012 added
    // `replyHold` (reply focus or draft) as an additional expand keeper.
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
