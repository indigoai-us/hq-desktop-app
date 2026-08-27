// @vitest-environment happy-dom
/**
 * US-003 — Sync: 'Desktop view moved' handoff card with Install/Open.
 *
 * Source-contract on the Rust intercept + real HqWorkHandoffCard mount
 * (mock invoker at the Tauri boundary). Do not open desktop-alt when the
 * handoff flag is on and HQ Work is missing.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import HqWorkHandoffCard from '../../src/components/HqWorkHandoffCard.svelte';
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

function styleRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
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

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function mountCard(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(HqWorkHandoffCard, { target: host, props });
  flushSync();
  return host;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  flushSync();
}

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
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
      expect(body).toMatch(/if crate::commands::hq_work::maybe_intercept_desktop_alt_handoff\(&app\)\?/);
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
      expect(hq).toContain('get_hq_work_handoff()');
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

  describe('Frontend card', () => {
    it('renders plain-language copy, Install/Open testids, and ghost wrapper', () => {
      const invokeFn = mockInvoker();
      mountCard({ invokeFn, firstShow: true });
      const card = host.querySelector('[data-testid="hq-work-handoff-card"]');
      expect(card).toBeTruthy();
      expect(card?.textContent).toContain('The HQ desktop view moved');
      expect(card?.textContent).toMatch(/HQ Work is the desktop app now/i);
      expect(host.querySelector('[data-testid="hq-work-handoff-install"]')?.textContent).toMatch(
        /Install/,
      );
      expect(host.querySelector('[data-testid="hq-work-handoff-open"]')).toBeNull();

      const source = readRepo('src/components/HqWorkHandoffCard.svelte');
      const wrapper = styleRule(source, '.handoff');
      expect(wrapper).toBeTruthy();
      const hasRadius = /border-radius/.test(wrapper);
      const hasBorder = /(?:^|[^-])border(?:-width|-style|-color)?:/.test(wrapper);
      const hasFill = /background(?:-color)?:/.test(wrapper);
      expect(hasRadius && hasBorder && hasFill).toBe(false);
      expect(source).toContain('data-testid="hq-work-handoff-card"');
      expect(source).toContain('data-testid="hq-work-handoff-install"');
      expect(source).toContain('data-testid="hq-work-handoff-open"');
    });

    it('Install invokes install_hq_work then swaps the CTA to Open / launch_hq_work', async () => {
      const invokeFn = mockInvoker();
      mountCard({ invokeFn, firstShow: false });
      const install = host.querySelector<HTMLButtonElement>(
        '[data-testid="hq-work-handoff-install"]',
      );
      expect(install).toBeTruthy();
      install?.click();
      await flush();
      expect(invokeFn.calls.map((c) => c.command)).toEqual(['install_hq_work']);
      const open = host.querySelector<HTMLButtonElement>('[data-testid="hq-work-handoff-open"]');
      expect(open).toBeTruthy();
      expect(host.querySelector('[data-testid="hq-work-handoff-install"]')).toBeNull();
      open?.click();
      await flush();
      expect(invokeFn.calls.map((c) => c.command)).toEqual([
        'install_hq_work',
        'launch_hq_work',
      ]);
      expect(invokeFn.calls[1].args).toEqual({ url: null });
    });

    it('failed install keeps the Install button', async () => {
      const invokeFn = mockInvoker((command) => {
        if (command === 'install_hq_work') throw new Error('signature verification failed');
        return undefined;
      });
      mountCard({ invokeFn });
      host.querySelector<HTMLButtonElement>('[data-testid="hq-work-handoff-install"]')?.click();
      await flush();
      expect(host.querySelector('[data-testid="hq-work-handoff-install"]')).toBeTruthy();
      expect(host.querySelector('[data-testid="hq-work-handoff-open"]')).toBeNull();
      expect(host.textContent).toMatch(/signature verification failed/);
    });

    it('App.svelte shows the card from handoff:show-card, not inside desktop-alt', () => {
      const app = readRepo('src/App.svelte');
      expect(app).toContain("listen<{ firstShow?: boolean }>('handoff:show-card'");
      expect(app).toContain('showHqWorkHandoff={showHandoffCard}');
      const desktopApp = readRepo('src/desktop-alt/DesktopApp.svelte');
      expect(desktopApp).not.toContain('hq-work-handoff-card');
      const popover = readRepo('src/components/Popover.svelte');
      expect(popover).toContain('HqWorkHandoffCard');
      expect(popover).toContain('showHqWorkHandoff');
      expect(app).toMatch(/else \{\s*\/\/ Handoff overlay[\s\S]*showHandoffCard = false;/);
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
