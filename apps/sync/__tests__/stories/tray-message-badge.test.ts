import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const app = read('src/App.svelte');
const build = read('src-tauri/build.rs');
const main = read('src-tauri/src/main.rs');
const bridge = read('src-tauri/src/tray_helper.rs');
const helper = read('src-tauri/helper/hq-tray-helper.swift');
const dmNotify = read('src-tauri/src/commands/dm_notify.rs');
const messages = read('src-tauri/src/commands/messages.rs');

describe('native HQ menu-bar message badge', () => {
  it('registers the badge bridge on every desktop target while spawning only on macOS', () => {
    expect(main).toMatch(/\nmod tray_helper;\n/);
    expect(main).not.toMatch(
      /#\[cfg\(target_os = "macos"\)\]\s*\nmod tray_helper;/,
    );
    expect(main).toContain('tray_helper::set_tray_message_badge');
    expect(bridge).toContain('#[cfg(target_os = "macos")]\npub fn spawn_and_poll');
    expect(bridge).toContain('#[cfg(not(target_os = "macos"))]');
  });

  it('routes the packaged helper through universal macOS 13 build validation', () => {
    expect(build).toContain('build_support/tray_helper.rs');
    expect(build).toContain('build_universal_helper');
    expect(build).not.toMatch(
      /Command::new\("swiftc"\)[\s\S]*?"helper\/hq-tray-helper"/,
    );
  });

  it('publishes the same aggregate count shown by the Messages surface', () => {
    expect(app).toContain('const messagesUnreadCount = $derived(');
    expect(app).toContain("invoke<void>('set_tray_message_badge', { count })");
    expect(main).toContain('tray_helper::set_tray_message_badge');
    expect(app).toContain('authenticated ? messagesUnreadCount : 0');
  });

  it('bridges the count to the native helper without a second poller', () => {
    expect(bridge).toContain('pub fn set_tray_message_badge(count: u32)');
    expect(bridge).toContain('.tray-badge');
    expect(bridge).toContain('write_badge_file');
    expect(bridge).not.toContain('poll_dm_once');
    expect(bridge).not.toContain('get_unread_summary');
  });

  it('renders a Dropbox-style capped counter over the HQ mark and keeps accessibility current', () => {
    expect(helper).toContain('.hq/.tray-badge');
    expect(helper).toContain('func refreshBadge()');
    expect(helper).toContain('final class TrayBadgeView');
    expect(helper).toContain('"9+"');
    expect(helper).toContain('NSColor.systemRed');
    expect(helper).toContain('addSubview(badgeView, positioned: .above');
    expect(helper).toContain('override func hitTest');
    expect(helper).toContain('imagePosition = hasMark ? .imageOnly : .noImage');
    expect(helper).toContain('setAccessibilityLabel');
    expect(helper).not.toContain('systemOrange');
    expect(helper).not.toContain('systemYellow');
    expect(helper).not.toContain('imagePosition = .imageLeading');
    expect(helper).toContain('1 item needs attention');
    expect(bridge).toContain('badge_write_lock()');
  });

  it('does not fetch or retry authenticated unread endpoints while signed out', () => {
    expect(app).toContain('if (!authenticated || channelUnreadDisposed) return');
    expect(app).toContain('if (!authenticated) {');
    expect(app).toContain('channelUnreadTracker.reset()');
    expect(app).toContain('if (authenticated) void loadUnreadSummary()');
    expect(app).toContain("await listen<{ channelId: string; unread: number }>(\n        'channel:unread-changed'");
  });

  it('clears native counts on DM view, channel read, channel decrease, and sign-out', () => {
    const resetStart = dmNotify.indexOf('pub fn reset_unread_dms');
    const resetEnd = dmNotify.indexOf('// ── Public API', resetStart);
    const resetBody = dmNotify.slice(resetStart, resetEnd);
    const readStart = messages.indexOf('pub async fn mark_channel_read');
    const readEnd = messages.indexOf('// ── Reactions', readStart);
    const readBody = messages.slice(readStart, readEnd);

    expect(resetBody).toContain('EVENT_DM_UNREAD_SUMMARY');
    expect(resetBody).toContain('"unreadDms": 0u32');
    expect(dmNotify).toContain('EVENT_CHANNEL_UNREAD_CHANGED');
    expect(dmNotify).toContain('unread_changes');
    expect(readBody).toContain('EVENT_CHANNEL_UNREAD_CHANGED');
    expect(readBody).toContain('"unread": 0u32');
    expect(app).toContain('resetUnreadSummary()');
  });
});
