import { describe, expect, it } from 'vitest';
import {
  fromV4Route,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import { V4_NAV_ITEMS } from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

/**
 * US-006 — US-008 combined Inbox (source contracts + route resolution).
 *
 * Locks the Messages + Notifications merge:
 *  - Exactly one combined primary destination (`inbox`).
 *  - Legacy `messages` / `notifications` resolve to inbox at both switch sites.
 *  - InboxPage hosts shared NotificationFeed / one-line NotificationRow with
 *    a title + unread-only header (no tabs / sync / overflow / chrome).
 *  - Message hover-expand + quick-reply + emoji react live in NotificationRow.
 */

describe('US-006 / US-008: combined Inbox route', () => {
  const route = readRepoFile('src/desktop-alt/route.ts');

  it('exactly one combined inbox destination in primary nav', () => {
    const inboxRows = V4_NAV_ITEMS.filter((item) => item.id === 'inbox');
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]).toEqual({ id: 'inbox', label: 'Inbox' });
    // No separate messages / notifications primary rows.
    expect(V4_NAV_ITEMS.map((i) => i.id)).not.toContain('messages');
    expect(V4_NAV_ITEMS.map((i) => i.id)).not.toContain('notifications');

    // Combined destination is also named in the route module's DesktopRoute union.
    expect(route).toContain("'inbox'");
    expect(route).toContain('US-008 merged Messages + Notifications into the single Inbox surface');
  });

  it('legacy messages / notifications → inbox at both resolution sites', () => {
    // resolvePendingDesktopRoute switch
    expect(resolvePendingDesktopRoute('messages')).toEqual({ kind: 'inbox' });
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ kind: 'inbox' });
    expect(resolvePendingDesktopRoute('inbox')).toEqual({ kind: 'inbox' });

    // fromV4Route switch
    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'inbox' });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'inbox' });
    expect(fromV4Route({ kind: 'inbox' })).toEqual({ kind: 'inbox' });

    // Both switch sites keep the legacy case arms.
    expect(route).toContain("case 'messages':");
    expect(route).toContain("case 'notifications':");
    expect(route).toContain("return { kind: 'inbox' }");
  });
});

describe('US-006 / US-008: InboxPage surface', () => {
  const inbox = readRepoFile('src/desktop-alt/pages/InboxPage.svelte');

  it('renders shared NotificationFeed / NotificationRow one-line rows', () => {
    expect(inbox).toContain("import NotificationFeed from '../../components/NotificationFeed.svelte'");
    expect(inbox).toContain(
      '<NotificationFeed showDayLabels={true} onunreadchange={handleUnreadChange} />',
    );
    expect(inbox).toContain('shared one-line NotificationRow');
  });

  it('unified unread header — title + count only', () => {
    expect(inbox).toContain('data-testid="inbox-unread-count"');
    expect(inbox).toContain("unread === 0 ? 'All caught up' : `${unread} unread`");
    expect(inbox).toContain('<h1 id="desktop-page-title">Inbox</h1>');
    // Header is title + unread only — no tabs / sync / overflow / hq icon / desktop-view
    // (comment is line-wrapped in source; assert the durable fragments).
    expect(inbox).toContain('Header is title + unread');
    expect(inbox).toContain('count ONLY — no tabs, no sync button, no menus (US-008).');
    expect(inbox).not.toContain('data-testid="desktop-alt-toggle"');
    expect(inbox).not.toContain('Sync Now');
    expect(inbox).not.toContain('overflow-menu');
    expect(inbox).not.toContain('hq-icon');
    expect(inbox).not.toContain('tab-selector');
    expect(inbox).not.toContain('role="tablist"');
  });
});

describe('US-006 / US-008: NotificationRow message hover-expand', () => {
  const row = readRepoFile('src/components/NotificationRow.svelte');
  const feed = readRepoFile('src/components/NotificationFeed.svelte');

  it('message rows hover-expand with quick-reply + emoji react', () => {
    expect(row).toContain('const expanded = $derived(isMessage && (hovered || focusWithin))');
    expect(row).toContain('class:nr-expanded={expanded}');
    expect(row).toContain('data-expanded={expanded}');
    // Quick-reply input
    expect(row).toContain('class="nr-reply"');
    expect(row).toContain('placeholder="Reply…"');
    expect(row).toContain('onreply?: (text: string) => void');
    // Emoji react
    expect(row).toContain("const REACT_EMOJI = ['👍', '❤️', '👀'] as const");
    expect(row).toContain('class="nr-react"');
    expect(row).toContain('onreact?: (emoji: string) => void');
    expect(row).toContain('onclick={() => onreact?.(emoji)}');
  });

  it('NotificationFeed wires reply/react into the shared row', () => {
    expect(feed).toContain('import NotificationRow from \'./NotificationRow.svelte\'');
    expect(feed).toContain('onreply={(text) => void replyDm(it, text)}');
    expect(feed).toContain('onreact={(emoji) => void reactDm(it, emoji)}');
  });
});
