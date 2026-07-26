import { afterEach, describe, expect, it } from 'vitest';

import { createDesktopAltHarness } from './live-driver';

/**
 * Live mode must never silently degrade.
 *
 * The Windows CI jobs set HQ_SYNC_DESKTOP_ALT_LIVE=1 and then spend ~20 minutes
 * building and installing a production NSIS bundle. If harness resolution fails
 * there, returning the scripted source-contract harness reports a pass that
 * proves nothing about the installed binary. Only an unset (implicit) live flag
 * is allowed to fall back.
 */
describe('createDesktopAltHarness live-mode strictness', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of ['HQ_SYNC_DESKTOP_ALT_LIVE', 'HQ_SYNC_DESKTOP_ALT_APP']) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('throws instead of falling back when live mode is requested but unresolvable', async () => {
    process.env.HQ_SYNC_DESKTOP_ALT_LIVE = '1';
    delete process.env.HQ_SYNC_DESKTOP_ALT_APP;

    await expect(createDesktopAltHarness('qa@getindigo.ai')).rejects.toThrow(
      /HQ_SYNC_DESKTOP_ALT_LIVE was requested but the live tauri-driver harness could not be resolved/,
    );
  });

  it('still falls back to the scripted harness when live mode was never requested', async () => {
    delete process.env.HQ_SYNC_DESKTOP_ALT_LIVE;
    delete process.env.HQ_SYNC_DESKTOP_ALT_APP;

    const harness = await createDesktopAltHarness('qa@getindigo.ai');
    expect(harness.mode).toBe('scripted');
  });
});
