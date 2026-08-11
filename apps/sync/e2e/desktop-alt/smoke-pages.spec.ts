import { describe, expect, it } from 'vitest';
import { createDesktopAltHarness } from './live-driver';

describe('desktop-alt smoke pages', () => {
  it.each([
    // The legacy 'sync' route resolves to the V4 Home surface (US-002/US-003).
    ['sync', 'Home'],
    ['meetings', 'Meetings'],
    ['company', 'New project'],
    // hq-desktop-v2 US-009: first-class company Skills / Workers pages.
    ['company-skills', 'Company-scoped workflows and operating knowledge'],
    ['company-workers', 'Company-scoped agents and specialist roles'],
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
