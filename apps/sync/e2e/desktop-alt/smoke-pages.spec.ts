import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolvePendingDesktopRoute,
  type DesktopRoute,
} from '../../src/desktop-alt/route';
import { createDesktopAltHarness } from './live-driver';

const root = process.cwd();

describe('desktop-alt smoke pages', () => {
  it.each([
    // The legacy 'sync' route resolves to the V4 Home surface (US-002/US-003).
    ['sync', 'Home'],
    ['meetings', 'Meetings'],
    ['company', 'New project'],
  ] as const)('renders %s without console errors', async (route, expectedMarker) => {
    const app = await createDesktopAltHarness('qa@getindigo.ai');

    try {
      await app.openDesktopAltWindow();

      const page = await app.navigate(route);

      expect(page.consoleErrors).toEqual([]);
      expect(page.text.some((text) => text.includes(expectedMarker))).toBe(true);
    } finally {
      await app.dispose?.();
    }
  });
});

describe('US-018 smoke — legacy shell retirement + deep-link remaps', () => {
  it('retired legacy shell files no longer exist', () => {
    expect(existsSync(join(root, 'src/desktop-alt/pages/InboxPage.svelte'))).toBe(false);
    expect(existsSync(join(root, 'src/desktop-alt/pages/MissionControlPage.svelte'))).toBe(false);
    expect(existsSync(join(root, 'src/desktop-alt/v4/V4Sidebar.svelte'))).toBe(false);
  });

  it('legacy deep links remap to live DesktopRoute kinds', () => {
    const cases: Array<[string, DesktopRoute['kind']]> = [
      ['inbox', 'notifications'],
      ['mission-control', 'home'],
      ['sync', 'home'],
      ['activity', 'home'],
      ['core-drift', 'home'],
      ['drift', 'home'],
      ['library:marketplace', 'marketplace'],
      ['notifications', 'notifications'],
      ['messages', 'messages'],
      ['meetings', 'meetings'],
    ];
    for (const [name, kind] of cases) {
      const resolved = resolvePendingDesktopRoute(name);
      expect(resolved, name).not.toBeNull();
      expect(resolved?.kind, name).toBe(kind);
    }
  });
});
