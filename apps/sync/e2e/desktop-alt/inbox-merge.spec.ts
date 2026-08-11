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
    // Architecture comment names the split (wording may evolve with IA docs).
    expect(route).toMatch(/Inbox/i);
    expect(route).toMatch(/Messages/i);
    expect(route).toMatch(/notification chronology/i);
  });

  it('messages → Messages while notifications → Inbox at both resolution sites', () => {
    // resolvePendingDesktopRoute switch
    expect(resolvePendingDesktopRoute('messages')).toEqual({ mode: 'internal', route: { kind: 'messages' } });
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ mode: 'internal', route: { kind: 'inbox' } });
    expect(resolvePendingDesktopRoute('inbox')).toEqual({ mode: 'internal', route: { kind: 'inbox' } });

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

describe('US-012: Inbox merged feed V2 — in-shell routing + mark-all-read', () => {
  const inbox = readRepoFile('src/desktop-alt/pages/InboxPage.svelte');
  const feed = readRepoFile('src/components/NotificationFeed.svelte');
  const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const widget = readRepoFile('src/components/Widget.svelte');

  it('feed rows accept in-shell open overrides while the popover defaults survive', () => {
    // Overrides exist and are consulted first…
    expect(feed).toContain('onopendm?: (dm: DmEvent) => void | Promise<void>');
    expect(feed).toContain('onopenshare?: (share: ShareEvent) => void | Promise<void>');
    expect(feed).toContain('onopenworkspace?: (company: string) => void | Promise<void>');
    expect(feed).toContain('if (onopendm) {');
    expect(feed).toContain('if (onopenshare) {');
    expect(feed).toContain('if (onopenworkspace) {');
    // …and the quick-window components are NOT deleted: the popover (no
    // overrides) still routes through them.
    expect(feed).toContain("invoke('open_dm_detail'");
    expect(feed).toContain("invoke('open_share_detail'");
  });

  it('Inbox rows open in-shell surfaces, not quick windows', () => {
    // DM → Messages conversation route (stash + navigate).
    expect(inbox).toContain('requestConversation(dmConversationTarget(dm))');
    expect(inbox).toContain("onnavigate?.({ kind: 'messages' })");
    // Share → Files preview; workspace event → company screen.
    expect(inbox).toContain('shareFilesRoute(share)');
    expect(inbox).toContain('workspaceActivityRoute(company)');
    // Wired into the shared feed.
    expect(inbox).toContain('onopendm={openDmConversation}');
    expect(inbox).toContain('onopenshare={openShareInFiles}');
    expect(inbox).toContain('onopenworkspace={openWorkspace}');
    // The Inbox never invokes the quick-window commands itself.
    expect(inbox).not.toContain('open_dm_detail');
    expect(inbox).not.toContain('open_share_detail');
    expect(inbox).not.toContain('open_desktop_alt_window');
  });

  it('DesktopApp supplies the in-shell navigate glue', () => {
    expect(app).toContain('<InboxPage onnavigate={navigate} />');
  });

  it('Mark all read clears badges across sidebar, tray, and widget', () => {
    expect(inbox).toContain('data-testid="inbox-mark-all-read"');
    expect(inbox).toContain('Mark all read');
    // Sidebar badge: markAllNotificationsRead broadcasts hq:notifications-read
    // (V2Sidebar listens); feed.markAllRead delegates to it.
    expect(inbox).toContain('feed?.markAllRead()');
    // Tray/Dock unread-DM badge clears via the messages-viewed command.
    expect(inbox).toContain("invoke('mark_messages_viewed')");
    // Widget: app-wide broadcast, consumed by the widget window.
    expect(inbox).toContain("emit('hq:notifications-all-read')");
    expect(widget).toContain("listen('hq:notifications-all-read'");
    expect(widget).toContain('markRecentRead(stack)');
  });

  it('keeps the unread · events header contract', () => {
    expect(inbox).toContain('data-testid="inbox-unread-count"');
    expect(inbox).toContain('unread === 0 ? \'All caught up\' : `${unread} unread`');
    expect(inbox).toContain('${unreadPart} · ${total} ${noun}');
  });
});
