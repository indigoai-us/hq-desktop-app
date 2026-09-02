import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-contract assertions for the notifications-first popover: the
// feed-folded system notices from the 0.9.9 redesign (#154), preserved through
// the chrome-free one-line panel (US-001) that superseded its visual design:
//   - system notices (membership / update / conflict / auth / errors / cloud)
//     fold INTO the notifications panel as pinned one-line rows instead of a
//     separate banner stack above the status row,
//   - the panel's unread badge counts active system notices alongside the
//     feed's own unread items,
//   - the feed suppresses its empty state while system notices are pinned,
//   - there is no standalone Settings gear / header chrome — Settings lives in
//     the desktop-view SettingsPage (US-005).

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const normalize = (s: string) => s.replace(/\s+/g, ' ');

const popover = read('src/components/Popover.svelte');
const app = read('src/App.svelte');
const feed = read('src/components/NotificationFeed.svelte');
const settingsPage = read('src/desktop-alt/pages/SettingsPage.svelte');

describe('notifications-first popover (feed-folded system notices)', () => {
  it('folds system notices into the panel as pinned one-line rows (no banner stack)', () => {
    const p = normalize(popover);
    // Membership + update + conflict + auth/error + manifest + cloud notices
    // render as pinned rows in the notifications section.
    expect(p).toContain('data-testid="popover-system-notice"');
    expect(p).toContain('{membershipNoticeTitle}');
    expect(p).toContain('Update available');
    expect(p).toContain('Sync now');
    expect(p).toContain('Sync paused');
    expect(p).toContain('Keep sync moving');
    expect(p).toContain('Cloud unreachable');
    // The legacy banner stack is gone.
    expect(popover).not.toContain('class="mbp-notices"');
    expect(popover).not.toContain('class="mbp-banner"');
    // Feed suppresses its empty state while system notices are pinned above it.
    expect(p).toContain('hideEmptyState={hasSystemNotices}');
    expect(feed).toContain('hideEmptyState');
  });

  it('counts system notices toward the panel unread badge', () => {
    const p = normalize(popover);
    expect(p).toContain('const systemNoticeCount = $derived(');
    expect(p).toContain('const notifBadge = $derived(unreadCount + systemNoticeCount)');
    expect(p).toContain("{notifBadge > 99 ? '99+' : notifBadge}");
  });

  it('hydrates updater history when no explicit updater prop is present and routes details to Updates', () => {
    const p = normalize(popover);
    expect(p).toContain('includeUpdates={!updateAvailable}');
    expect(p).toContain("route: 'settings:updates'");
    expect(p).toContain('let openingUpdates = $state(false)');
    expect(p).toContain('aria-busy={openingUpdates}');
    expect(p).toContain("{openingUpdates ? 'Opening…' : 'View updates'}");
    expect(p).toContain('data-testid="popover-updates-error"');
    expect(p).toContain('data-testid="popover-install-error"');
    expect(p).toContain('aria-busy={updateInstalling}');
    expect(normalize(app)).toContain('let updateInstallError = $state<string | null>(null)');
    expect(normalize(app)).toContain(
      "updateInstallError = 'Couldn’t install the update. Try again.'",
    );
    expect(normalize(app)).toContain('{updateInstallError}');
  });

  it('restores a flat Messages entry with the aggregate DM, request, and channel count', () => {
    const p = normalize(popover);
    const a = normalize(app);

    expect(p).toContain('data-testid="popover-open-messages"');
    expect(p).toContain("invoke('open_communications_window')");
    expect(p).toContain('let openingMessages = $state(false)');
    expect(p).toContain('disabled={openingMessages}');
    expect(p).toContain('aria-busy={openingMessages}');
    expect(p).toContain('{messagesUnreadCount > 99 ? \'99+\' : messagesUnreadCount}');

    expect(a).toContain('const messagesUnreadCount = $derived(');
    expect(a).toContain('Math.max(0, unreadSummary.unreadDms)');
    expect(a).toContain('Math.max(0, unreadSummary.pendingRequests)');
    expect(a).toContain('Math.max(0, unreadSummary.channelUnread)');
    expect(a).toContain("invoke<ChannelsUnreadResponse | null>('list_channels')");
    expect(a).toContain("'channel:unread-changed'");
    expect(a).toContain("'channel:updated'");
    expect(a).toContain('{messagesUnreadCount}');

    expect(popover).toMatch(
      /\.mbp-messages-entry\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/,
    );
  });

  it('keeps compact sync status and omits the always-busy progress bar', () => {
    const p = normalize(popover);
    expect(p).toContain('data-testid="popover-status-row"');
    expect(p).toContain('{statusTitle}');
    expect(p).toContain('{lastSyncLabel}');
    expect(p).toContain('data-testid="popover-sync-sublabel"');
    expect(p).toContain('{liveWorkspaceLine}');
    expect(popover).not.toContain('mbp-progress-track');
    expect(popover).not.toContain('barPct');
    expect(popover).not.toContain('role="progressbar"');
  });

  it('keeps the full desktop one explicit text action away', () => {
    const p = normalize(popover);

    expect(p).toContain('data-testid="popover-open-desktop"');
    expect(p).toContain('let openingDesktop = $state(false)');
    expect(p).toContain('aria-busy={openingDesktop}');
    expect(p).toContain("{openingDesktop ? 'Opening…' : 'Open desktop'}");
  });

  it('preserves a readable actor/message/timestamp lane at the native compact width', () => {
    expect(popover).toContain('.mbp-sec :global(.nr)');
    expect(popover).toContain('font-size: 12px');
    expect(popover).toContain('.mbp-sec :global(.nr-meta-type)');
    expect(popover).toMatch(
      /\.mbp-sec :global\(\.nr-meta-type\)\s*\{\s*display:\s*none;/,
    );
    expect(popover).toContain('-webkit-line-clamp: 1');
  });

  it('keeps the detailed conflict resolver as its own card, mutually exclusive with the summary row', () => {
    const p = normalize(popover);
    expect(p).toContain('const conflictModalActive = $derived(showConflictModal && conflicts.length > 0)');
    expect(p).toContain("syncState === 'conflict' && !conflictModalActive");
    expect(p).toContain('class="mbp-conflict-card"');
  });

  it('has no standalone Settings gear or header chrome — Settings lives in the desktop view', () => {
    expect(popover).not.toContain('data-testid="popover-settings-gear"');
    expect(popover).not.toContain('class="mbp-head"');
    expect(popover).not.toContain('onsettings');
    // The macOS-Settings content (telemetry consent + automatic updates) is
    // reachable in the relocated desktop-view SettingsPage.
    expect(settingsPage).toContain('Usage telemetry');
    expect(settingsPage).toContain('Automatic updates');
  });
});
