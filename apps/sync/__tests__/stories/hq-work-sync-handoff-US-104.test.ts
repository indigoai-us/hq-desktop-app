// @vitest-environment happy-dom
/**
 * US-104 — Internal notification + deep-link routing to channels.
 *
 * Notification/widget clicks become a validated hqwork:// route payload that
 * applyDesktopAltRoute feeds into DesktopApp's pending-open path. No
 * launch_hq_work hop.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OPEN_SETTINGS_EVENT,
  takePendingChannelOpen,
  takePendingConversation,
} from '@hq/ui';
import { applyDesktopAltRoute } from '../../src/desktop-alt/hq-work-host';
import {
  hqWorkHandoffEnabled,
  hqworkQueryToken,
  isValidHqWorkDeepLink,
  parseHqWorkOpenUrl,
} from '../../src/lib/hq-work';

const repoRoot = resolve(process.cwd());

function readRepo(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, ...parts), 'utf8');
}

/** Product path: intercept builds this URL, host applies it. */
function notificationClick(url: string): void {
  applyDesktopAltRoute(url);
}

afterEach(() => {
  takePendingChannelOpen();
  takePendingConversation();
});

describe('US-104 internal notification + deep-link routing', () => {
  it('hq_work_handoff still defaults false', () => {
    expect(hqWorkHandoffEnabled(undefined)).toBe(false);
    expect(hqWorkHandoffEnabled(null)).toBe(false);
    expect(hqWorkHandoffEnabled(false)).toBe(false);
    expect(hqWorkHandoffEnabled(true)).toBe(true);
  });

  describe('Given a channel-message notification, when clicked', () => {
    it('then the embedded UI opens that channel', () => {
      notificationClick('hqwork://open?channel=chn_proj');
      expect(takePendingChannelOpen()).toEqual({
        channelId: 'chn_proj',
        messageId: null,
        createdAt: null,
        replyRootEventId: null,
      });
      expect(takePendingConversation()).toBeNull();
    });

    it('then the reply thread opens when the payload carries one', () => {
      notificationClick('hqwork://open?channel=chn_proj&reply=evt_root');
      expect(takePendingChannelOpen()).toEqual({
        channelId: 'chn_proj',
        messageId: null,
        createdAt: null,
        replyRootEventId: 'evt_root',
      });
      expect(takePendingConversation()).toBeNull();
    });
  });

  it('opens a DM thread from person= via pending conversation, not channel', () => {
    notificationClick('hqwork://open?person=prs_ada');
    expect(takePendingChannelOpen()).toBeNull();
    expect(takePendingConversation()).toMatchObject({
      personUid: 'prs_ada',
      replyRootEventId: null,
    });
    notificationClick('hqwork://open?person=prs_ada&reply=evt_dm');
    expect(takePendingConversation()).toMatchObject({
      personUid: 'prs_ada',
      replyRootEventId: 'evt_dm',
    });
  });

  it('channel wins over person on a mixed payload', () => {
    notificationClick('hqwork://open?channel=chn_proj&person=prs_ada');
    expect(takePendingChannelOpen()?.channelId).toBe('chn_proj');
    expect(takePendingConversation()).toBeNull();
  });

  it('reuses the superseded branch token charset', () => {
    expect(hqworkQueryToken('chn_x')).toBe('chn_x');
    expect(hqworkQueryToken('prs_ada')).toBe('prs_ada');
    expect(hqworkQueryToken('evt_root')).toBe('evt_root');
    expect(hqworkQueryToken('a.b-c_d~e')).toBe('a.b-c_d~e');
    expect(hqworkQueryToken('')).toBeNull();
    expect(hqworkQueryToken('  ')).toBeNull();
    expect(hqworkQueryToken('bad id')).toBeNull();
    expect(hqworkQueryToken('a"b')).toBeNull();
    expect(hqworkQueryToken("a'b")).toBeNull();
    expect(hqworkQueryToken('a<b>')).toBeNull();
    expect(hqworkQueryToken('a\\b')).toBeNull();
    expect(hqworkQueryToken('a|b')).toBeNull();
    expect(parseHqWorkOpenUrl('hqwork://open?channel=chn_x')?.channelId).toBe(
      'chn_x',
    );
    expect(isValidHqWorkDeepLink('hqwork://open?channel=chn_x')).toBe(true);
    expect(isValidHqWorkDeepLink('hqwork://open')).toBe(false);
  });

  it('ignores malformed or unknown hqwork URLs without stashing a pending open', () => {
    for (const bad of [
      '',
      'https://example.com?channel=chn_proj',
      'file:///etc/passwd',
      'hqwork://settings',
      'hqwork://open',
      'hqwork://open?thread=evt_root',
      'hqwork://open?channel=',
      'hqwork://open?channel=a b',
      'not-a-url',
    ]) {
      expect(parseHqWorkOpenUrl(bad)).toBeNull();
      notificationClick(bad);
      expect(takePendingChannelOpen()).toBeNull();
      expect(takePendingConversation()).toBeNull();
    }
  });

  it('applyDesktopAltRoute still maps settings onto OPEN_SETTINGS_EVENT', () => {
    const seen: string[] = [];
    const onSettings = () => {
      seen.push('settings');
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onSettings);
    applyDesktopAltRoute(null);
    applyDesktopAltRoute('meetings');
    applyDesktopAltRoute('inbox');
    applyDesktopAltRoute('messages');
    applyDesktopAltRoute('settings');
    applyDesktopAltRoute('settings:updates');
    applyDesktopAltRoute('settings/general');
    window.removeEventListener(OPEN_SETTINGS_EVENT, onSettings);
    expect(seen).toEqual(['settings', 'settings', 'settings']);
    expect(takePendingChannelOpen()).toBeNull();
  });

  it('HqWorkDesktopShell maps desktop:navigate / pending route onto applyDesktopAltRoute', () => {
    const shell = readRepo('src/desktop-alt/HqWorkDesktopShell.svelte');
    expect(shell).toContain('applyDesktopAltRoute');
    expect(shell).toContain("listen<string>('desktop:navigate'");
    expect(shell).toContain('desktop_alt_consume_pending_route');
    expect(shell).not.toContain('launchHqWork');
    expect(shell).not.toContain('launch_hq_work');
  });

  it('flag-on intercepts open this window, never launch_hq_work', () => {
    const hq = readRepo('src-tauri/src/commands/hq_work.rs');
    const conversation = hq.slice(
      hq.indexOf('fn maybe_intercept_conversation_open'),
      hq.indexOf('fn maybe_intercept_dm_open'),
    );
    const dm = hq.slice(
      hq.indexOf('fn maybe_intercept_dm_open'),
      hq.indexOf('fn hide_compact_popover'),
    );
    expect(conversation).toContain('spawn_embedded_desktop_open');
    expect(conversation).toContain('embedded_conversation_route');
    expect(conversation).not.toContain('launch_hq_work');
    expect(dm).toContain('spawn_embedded_desktop_open');
    expect(dm).not.toContain('launch_hq_work');
    expect(hq).toContain('open_desktop_alt_window_inner');
    expect(hq).toContain('internal_route_from_external_hqwork_url');
  });
});
