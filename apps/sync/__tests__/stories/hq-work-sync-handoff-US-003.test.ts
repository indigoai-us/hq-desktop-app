// @vitest-environment happy-dom
/**
 * US-003 — Sync: 'Desktop view moved' handoff card with Install/Open.
 *
 * Source-contract on the Rust intercept and the invoke wrappers (mock
 * invoker at the Tauri boundary). Do not open desktop-alt when the handoff
 * flag is on and HQ Work is missing. The HqWorkHandoffCard UI these tests
 * also covered was deleted in 434f0b31 (the desktop workspace replaced the
 * classic popover shell), so its tests went with it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getHqWorkHandoffCardShown,
  installHqWork,
  launchHqWork,
  type HqWorkInvoker,
} from '../../src/lib/hq-work';

const repoRoot = resolve(process.cwd());

function readRepo(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, ...parts), 'utf8');
}

function mockInvoker(
  impl?: (command: string, args?: Record<string, unknown>) => unknown,
): HqWorkInvoker & { calls: Array<{ command: string; args?: Record<string, unknown> }> } {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const fn = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return impl?.(command, args);
  }) as HqWorkInvoker;
  return Object.assign(fn, { calls });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('US-003 desktop-view-moved handoff card', () => {
  describe('Rust intercept seam', () => {
    it('open_desktop_alt_window_inner intercepts when flag on and HQ Work is missing', () => {
      const src = readRepo('src-tauri/src/commands/desktop_alt.rs');
      const idx = src.indexOf('pub async fn open_desktop_alt_window_inner');
      expect(idx).toBeGreaterThan(-1);
      const body = src.slice(idx, idx + 2800);
      expect(body).toContain('maybe_intercept_desktop_alt_handoff');
      expect(body).toMatch(
        /if crate::commands::hq_work::maybe_intercept_desktop_alt_handoff\(&app,\s*route\)\?/,
      );
      expect(body).toContain('return Ok(())');
      const interceptAt = body.indexOf('maybe_intercept_desktop_alt_handoff');
      const hideAt = body.indexOf('get_webview_window("main")');
      expect(interceptAt).toBeGreaterThan(-1);
      expect(hideAt).toBeGreaterThan(interceptAt);
    });

    it('flag off still opens desktop-alt (rollback)', () => {
      const hq = readRepo('src-tauri/src/commands/hq_work.rs');
      expect(hq).toContain('fn should_intercept_desktop_alt');
      expect(hq).toContain('handoff_enabled && !installed');
      expect(hq).toContain('DesktopAltHandoffPlan::OpenDesktopAlt');
      const desktop = readRepo('src-tauri/src/commands/desktop_alt.rs');
      const idx = desktop.indexOf('pub async fn open_desktop_alt_window_inner');
      const body = desktop.slice(idx, idx + 3500);
      expect(body).toContain('WINDOW_LABEL');
      expect(body).toContain('desktop-alt.html');
    });

    it('installed skips the card and keeps opening desktop-alt', () => {
      const hq = readRepo('src-tauri/src/commands/hq_work.rs');
      expect(hq).toMatch(
        /plan_desktop_alt_open[\s\S]*should_intercept_desktop_alt[\s\S]*OpenDesktopAlt/,
      );
      expect(hq).toContain('hq_work_installed()');
    });

    it('persists hqWorkHandoffCardShown via merge_menubar_flags', () => {
      const hq = readRepo('src-tauri/src/commands/hq_work.rs');
      expect(hq).toContain('hqWorkHandoffCardShown');
      expect(hq).toContain('merge_menubar_flags');
      expect(hq).toContain('mark_hq_work_handoff_card_shown');
      expect(hq).toContain('handoff:show-card');
    });

    it('install verifies minisign and refuses unsigned bytes', () => {
      const hq = readRepo('src-tauri/src/commands/hq_work.rs');
      expect(hq).toContain('HQ_WORK_FEED_URL');
      expect(hq).toContain(
        'https://indigo-electron-releases.s3.us-east-1.amazonaws.com/hq-work/latest.json',
      );
      expect(hq).toContain('HQ_WORK_UPDATER_PUBKEY');
      expect(hq).toContain('verify_hq_work_bytes');
      expect(hq).toContain('refusing to install unsigned HQ Work bytes');
      expect(hq).toContain('require_artifact_signature');
      expect(hq).toContain('install_hq_work_with');
    });
  });

  describe('invoke wrappers', () => {
    it('installHqWork and card-shown round-trip through the invoker', async () => {
      const invokeFn = mockInvoker(() => true);
      await installHqWork(invokeFn);
      expect(await getHqWorkHandoffCardShown(invokeFn)).toBe(true);
      await launchHqWork(invokeFn, null);
      expect(invokeFn.calls.map((c) => c.command)).toEqual([
        'install_hq_work',
        'get_hq_work_handoff_card_shown',
        'launch_hq_work',
      ]);
    });
  });
});
