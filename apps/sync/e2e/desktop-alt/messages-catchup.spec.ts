import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Agent-native Messages — the approved minimal room rail replaces the old
 * ranked catch-up digest. Activity remains reachable as an explicit shortcut,
 * while DMs, group DMs, and channels stay compact and preview-free.
 */

describe('desktop-alt Messages room rail and activity shortcut', () => {
  const shell = readRepoFile('src/components/messaging/MessagesShell.svelte');
  const catchUp = readRepoFile('src/components/messaging/v4/CatchUp.svelte');

  it('keeps the rail room-focused instead of mounting a ranked digest', () => {
    expect(shell).not.toContain("import CatchUp, { type CatchUpItem } from './v4/CatchUp.svelte'");
    expect(shell).not.toContain('<CatchUp');
    expect(shell).toContain('<span>Direct messages</span>');
    expect(shell).toContain('<span>Channels</span>');
    expect(shell).toContain('Mentions & activity');
  });

  it('derives its unread summary from authoritative DM, channel, and request state', () => {
    expect(shell).toContain('const railUnreadCount = $derived(');
    expect(shell).toContain('unreadSummary.unreadDms');
    expect(shell).toContain('channel.unread ?? 0');
    expect(shell).toContain('requests.length');
    expect(shell).toContain('summary?.pendingRequests');
    expect(shell).not.toContain("((c.previewDirection ?? c.lastMessageDirection) ?? '') === 'in'");
  });

  it('routes the activity shortcut to the full inbox with a loading state', () => {
    expect(shell).toContain('async function openMentionsAndActivity');
    expect(shell).toContain("invoke('open_desktop_alt_window', { route: 'inbox' })");
    expect(shell).toContain('aria-busy={openingActivity}');
    expect(shell).toContain("openingActivity ? 'Opening activity…' : 'Mentions & activity'");
  });

  it('frames the digest honestly (waiting, not unread) and is dismissible + token-safe', () => {
    expect(catchUp).toContain('waiting');
    expect(catchUp).not.toContain('} unread</span>');
    expect(catchUp).toContain('ondismiss');
    expect(catchUp).toContain('catch-up-hide');
    // CatchUp renders inside MessagesShell's cascade (desktop-alt.css + popover.css),
    // which does NOT resolve --v4-* tokens — so the component must not use them.
    const style = catchUp.split('<style>')[1] ?? '';
    expect(style).not.toMatch(/var\(--v4-/);
    // No purple accent.
    expect(style).not.toMatch(/var\(--accent/);
  });

  it('keeps the digest wrapper and ranked items open and divider-led', () => {
    const wrapper = catchUp.match(/\.catch-up\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const card = catchUp.match(/\.ranked-card\s*\{([\s\S]*?)\}/)?.[1] ?? '';

    expect(wrapper).toContain('padding: 0');
    expect(wrapper).toContain('border: 0');
    expect(wrapper).toContain('border-radius: 0');
    expect(wrapper).toContain('background: transparent');
    expect(card).toContain('border: 0');
    expect(card).toContain('border-top: 1px solid var(--border)');
    expect(card).toContain('border-radius: 0');
    expect(card).toContain('background: transparent');
  });
});
