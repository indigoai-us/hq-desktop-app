/**
 * "Needs you" notifications for in-app agent sessions.
 *
 * A session that parks on a permission prompt or a question is invisible until
 * the user happens to look at it. This story covers the three surfaces that
 * make it visible — the banner, the tray badge, and the click that lands on the
 * parked session — across the Rust/TS seam.
 *
 * The sync suite runs in node, so the routing half is EXECUTED (the real
 * `executeSessionNotificationAction` against a fake invoke) and the wiring that
 * only exists as an emit-site hook or Svelte markup is pinned at the source
 * level. Source pins are deliberate: the hook in `AppSink` is the single point
 * both the Claude and the Codex driver share, and losing it would silence every
 * notification while every unit test still passed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { resolvePendingDesktopRoute } from '../../src/desktop-alt/route';
import {
  executeSessionNotificationAction,
  sessionBannerRoute,
} from '../../src/lib/sessionNotificationAction';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');

const APP = read('src/App.svelte');
const ROUTER = read('src/lib/bannerActionRouter.ts');
const CLAUDE_RS = read('src-tauri/src/commands/agent_session/claude.rs');
const NOTIFY_RS = read('src-tauri/src/commands/agent_session/notify.rs');
const TRAY_RS = read('src-tauri/src/tray.rs');

describe('session banner → route', () => {
  it('deep-links the parked session, not the session list', () => {
    expect(sessionBannerRoute({ sessionId: 'abc', requestId: 'req-1' })).toBe('sessions:abc');
  });

  it('produces a route the desktop resolver actually understands', () => {
    const route = sessionBannerRoute({ sessionId: 'abc' });
    expect(route).not.toBeNull();
    // The end of the wire: Rust hands this string to open_desktop_alt_window,
    // which the desktop shell resolves on mount / on desktop:navigate.
    expect(resolvePendingDesktopRoute(route as string)).toEqual({
      kind: 'sessions',
      id: 'abc',
    });
  });

  it('rejects a payload that cannot name its session', () => {
    expect(sessionBannerRoute({})).toBeNull();
    expect(sessionBannerRoute({ sessionId: '   ' })).toBeNull();
    expect(sessionBannerRoute({ sessionId: 42 })).toBeNull();
    expect(sessionBannerRoute(null)).toBeNull();
    expect(sessionBannerRoute(undefined)).toBeNull();
  });
});

describe('session banner → action', () => {
  it('opens the desktop window on the session route', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    await executeSessionNotificationAction('open', { sessionId: 'abc' }, invoke);
    expect(invoke).toHaveBeenCalledWith('open_desktop_alt_window', {
      route: 'sessions:abc',
    });
  });

  it('rejects an incomplete payload instead of reporting a successful click', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    await expect(
      executeSessionNotificationAction('open', {}, invoke),
    ).rejects.toThrow(/Session is unavailable/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects an action the session banner never dispatches', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    await expect(
      executeSessionNotificationAction('record', { sessionId: 'abc' }, invoke),
    ).rejects.toThrow(/Unsupported notification action/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('propagates an invoke failure so the ack bridge reports failure', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('window refused'));
    await expect(
      executeSessionNotificationAction('open', { sessionId: 'abc' }, invoke),
    ).rejects.toThrow(/window refused/);
  });
});

describe('the routing is reachable from the banner-action router', () => {
  it('`session` is a routable notification kind', () => {
    expect(ROUTER).toContain("| 'session'");
  });

  it('App.svelte routes kind === session through the session action', () => {
    expect(APP).toContain("import { executeSessionNotificationAction } from './lib/sessionNotificationAction'");
    expect(APP).toContain("} else if (kind === 'session') {");
    expect(APP).toContain('await executeSessionNotificationAction(action, data, (command, args) =>');
  });
});

describe('the Rust emit site is hooked', () => {
  it('both drivers reach notify through the shared AppSink', () => {
    // Claude and Codex both emit through `AppSink`, so these two lines are the
    // whole wiring. If either disappears, notifications go silent.
    expect(CLAUDE_RS).toContain('super::notify::on_needs_you(&self.0, session_id, needs);');
    expect(CLAUDE_RS).toContain('super::notify::on_phase(&self.0, session_id, change);');
  });

  it('the banner payload the frontend routes on is the one Rust builds', () => {
    expect(NOTIFY_RS).toContain('pub const BANNER_KIND: &str = "session"');
    expect(NOTIFY_RS).toContain('"sessionId": needs.session_id,');
    expect(NOTIFY_RS).toContain('"requestId": needs.request_id,');
  });

  it('the tray badge is derived from the registry, not accumulated', () => {
    expect(NOTIFY_RS).toContain('pub fn needs_you_count(rows: &[SessionSummary]) -> usize');
    expect(TRAY_RS).toContain('pub fn set_session_badge(app: &AppHandle, count: usize)');
    expect(TRAY_RS).toContain('sessions need');
  });
});
